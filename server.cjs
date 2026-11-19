/*
SPDX-FileCopyrightText: 2026 晨钟酱Official
SPDX-License-Identifier: GPL-3.0-only
See LICENSE for the full license text.
*/
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const https=require('node:https');
const net=require('node:net');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const root=__dirname,port=Number(process.env.PORT||8124);
const {HTTPS_CERT:certPath,HTTPS_KEY:keyPath}=process.env;
const adbPorts={local:5037,wireless:5038};
const adbRoutes=new Map([['/api/adb/local-socket',adbPorts.local],['/api/adb/socket',adbPorts.wireless]]);
const run=promisify(execFile);
let webSockets,startup;
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.md':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8'};

function isLocalPage(req){
  const {host,origin}=req.headers;
  const port=req.socket.localPort;
  const encrypted=req.socket.encrypted;
  const protocol=encrypted?'https':'http';
  const suffix=port===(encrypted?443:80)?'':`:${port}`;
  return (host===`127.0.0.1${suffix}`||host===`localhost${suffix}`)&&origin===`${protocol}://${host}`;
}

function readHttpsOptions(){
  if(!certPath&&!keyPath)return null;
  if(!certPath||!keyPath)throw new Error('启用 HTTPS 时请同时设置 HTTPS_CERT 和 HTTPS_KEY');
  const privateKey=path.resolve(keyPath);
  const resolvedKey=fs.realpathSync(privateKey);
  const webRoot=fs.realpathSync(root);
  for(const filename of [privateKey,resolvedKey]){
    const relative=path.relative(webRoot,filename);
    if(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)){
      throw new Error('HTTPS 私钥必须放在项目目录之外，以免被静态服务器提供下载');
    }
  }
  return {cert:fs.readFileSync(certPath),key:fs.readFileSync(resolvedKey)};
}

function getWebSockets(){
  if(webSockets)return webSockets;
  let wsLibrary;
  try{wsLibrary=require('ws');}catch(error){
    if(error.code==='MODULE_NOT_FOUND')throw new Error('缺少无线桥接依赖，请在项目目录运行 npm install 后重启服务');
    throw error;
  }
  const {WebSocketServer,createWebSocketStream}=wsLibrary;
  webSockets=new WebSocketServer({noServer:true,maxPayload:2*1024*1024});
  webSockets.on('connection',(ws,adbPort)=>{
    const stream=createWebSocketStream(ws);
    const adb=net.createConnection({host:'127.0.0.1',port:adbPort});
    adb.setTimeout(5000,()=>adb.destroy(new Error('ADB connection timed out')));
    adb.once('connect',()=>adb.setTimeout(0));
    adb.on('error',()=>ws.close(1011,'Local ADB connection failed'));
    stream.on('error',()=>adb.destroy());
    ws.once('close',()=>adb.destroy());
    stream.pipe(adb);
    adb.pipe(stream);
  });
  return webSockets;
}

function isAdbListening(port){
  return new Promise(resolve=>{
    const socket=net.createConnection({host:'127.0.0.1',port});
    const done=available=>{socket.destroy();resolve(available);};
    socket.once('connect',()=>done(true));
    socket.once('error',()=>done(false));
    socket.setTimeout(1000,()=>done(false));
  });
}

async function startAdb(){
  const adbPort=adbPorts.wireless;
  startup??=run(process.env.ADB_PATH||'adb',['-L',`tcp:${adbPort}`,'start-server'],{
    env:{...process.env,ADB_USB:'0',ADB_EMU:'0'},
    timeout:15000,
    windowsHide:true
  }).catch(error=>{
    if(error.code==='ENOENT')throw new Error('找不到 adb，请安装 Android SDK Platform-Tools 并加入 PATH，或设置 ADB_PATH 后重启服务');
    throw new Error(`本机 ADB 启动失败，请检查 Platform-Tools 和端口 ${adbPort}。`,{cause:error});
  }).finally(()=>{startup=undefined;});
  await startup;
}

async function handleRequest(req,res){
  if(req.url==='/api/adb/start'||req.url==='/api/adb/servers'){
    if(req.method!=='POST'||!isLocalPage(req)){res.writeHead(403).end();return;}
    try{
      getWebSockets();
      if(req.url==='/api/adb/start'){
        await startAdb();
        res.writeHead(204,{'Cache-Control':'no-store'}).end();
      }else{
        const servers=Object.keys(adbPorts);
        const listening=await Promise.all(servers.map(server=>isAdbListening(adbPorts[server])));
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
        res.end(JSON.stringify(servers.filter((_,index)=>listening[index])));
      }
    }catch(error){
      res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify({error:error.message}));
    }
    return;
  }
  let filename;
  try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);filename=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));}catch{res.writeHead(400);res.end('Bad request');return;}
  if(!filename.startsWith(root+path.sep)){res.writeHead(403);res.end('Forbidden');return;}
  fs.readFile(filename,(error,data)=>{if(error){res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'Content-Type':types[path.extname(filename)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);});
}

const tls=readHttpsOptions();
const server=tls?https.createServer(tls,handleRequest):http.createServer(handleRequest);
server.on('upgrade',(req,socket,head)=>{
  const adbPort=adbRoutes.get(req.url);
  if(!adbPort||!isLocalPage(req)){
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  let bridge;
  try{bridge=getWebSockets();}catch{socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}
  bridge.handleUpgrade(req,socket,head,ws=>bridge.emit('connection',ws,adbPort));
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`端口 ${port} 已被占用，请设置 PORT 为其他端口后重试。`:error.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`搞机工具箱已启动：${tls?'https':'http'}://127.0.0.1:${server.address().port}\n按 Ctrl+C 停止。`));
