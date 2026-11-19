/*
SPDX-FileCopyrightText: 2026 晨钟酱Official
SPDX-License-Identifier: GPL-3.0-only
See LICENSE for the full license text.
*/
import {GJ} from "./core.js";
const GJTransport = (() => {
  let adbLib,streamLib,usbLib,CredentialStore,manager,loading;
  const serverRoutes={local:'/api/adb/local-socket',wireless:'/api/adb/socket'};
  const deviceStates=['device','unauthorized','offline','recovery','sideload','bootloader'];
  async function load(){if(loading)return loading;loading=(async()=>{[adbLib,streamLib,usbLib,{default:CredentialStore}]=await Promise.all([import("./vendor/adb.js"),import("./vendor/stream-extra.js"),import("./vendor/adb-daemon-webusb.js"),import("./vendor/adb-credential-web.js")]);const bytes=new Uint8Array([1]);if(streamLib.MaybeConsumable.getValue(new streamLib.Consumable(bytes))!==bytes)throw new Error('流依赖实例不一致');manager=usbLib.AdbDaemonWebUsbDeviceManager.BROWSER;})();return loading;}
  async function devices(){if(!manager)return[];return manager.getDevices();}
  async function collect(readable,{limit=32*1024*1024,progress,onChunk}={}){const reader=readable.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error(`输出超过 ${Math.round(limit/1048576)} MB，请缩小命令范围或停止长时间运行的命令`);chunks.push(value);progress?.(size);onChunk?.(value);}return GJ.joinBytes(chunks);}finally{reader.releaseLock();}}
  class Driver {
    constructor(adb,{serial,label,kind='usb',closeOwned=async()=>{}}){this.adb=adb;this.kind=kind;this.serial=serial||adb.serial;this.label=label||this.serial;this.connected=true;this.closeOwned=closeOwned;this.disconnected=adb.disconnected.then(()=>{this.connected=false;},e=>{this.connected=false;throw e;});this.disconnected.catch(()=>{});this.sessions=new Set();this.processes=new Set();}
    async trackProcess(process){
      if(!this.connected){await process.kill();throw new Error('设备已断开');}
      this.processes.add(process);
      const forget=()=>this.processes.delete(process);
      process.exited.then(forget,forget);
      return process;
    }
    async openTerminal(){
      const shell=this.adb.subprocess.shellProtocol;
      return this.trackProcess(shell?await shell.pty({terminalType:'xterm-256color'}):await this.adb.subprocess.noneProtocol.pty());
    }
    async openProcess(command,signal){
      const shell=this.adb.subprocess.shellProtocol;
      if(!shell)throw new Error('模拟手柄需要 Android 设备支持 ADB Shell v2');
      return this.trackProcess(await shell.spawn(command,signal));
    }
    async exec(command,{signal,onStdout,onStderr}={}){GJ.checkAbort(signal);const shell=this.adb.subprocess.shellProtocol;if(shell){const proc=await shell.spawn(command,signal),outDecoder=new TextDecoder(),errDecoder=new TextDecoder();const jobs=[collect(proc.stdout,{onChunk:onStdout?bytes=>{const text=outDecoder.decode(bytes,{stream:true});if(text)onStdout(text);}:undefined}),collect(proc.stderr,{onChunk:onStderr?bytes=>{const text=errDecoder.decode(bytes,{stream:true});if(text)onStderr(text);}:undefined}),proc.exited,proc.stdin.close()];try{const [stdout,stderr,exitCode]=await Promise.all(jobs);const outEnd=outDecoder.decode(),errEnd=errDecoder.decode();if(outEnd)onStdout?.(outEnd);if(errEnd)onStderr?.(errEnd);return {stdout:new TextDecoder().decode(stdout),stderr:new TextDecoder().decode(stderr),exitCode};}catch(error){await proc.kill().catch(()=>{});await Promise.allSettled(jobs);throw error;}}
      const marker='__GJ_EXIT_'+crypto.randomUUID().replaceAll('-','')+'__';const proc=await this.adb.subprocess.noneProtocol.spawn(`(\n${command}\n); __gj_status=$?; printf '\\n${marker}%s' "$__gj_status"`,signal);const jobs=[collect(proc.output),proc.exited,proc.stdin.close()];try{const [bytes]=await Promise.all(jobs);const text=new TextDecoder().decode(bytes),at=text.lastIndexOf('\n'+marker);if(at<0)throw new Error('设备没有返回命令退出状态');const exitCode=Number(text.slice(at+marker.length+1).trim());if(!Number.isFinite(exitCode))throw new Error('设备返回了无效退出状态');return{stdout:text.slice(0,at),stderr:'',exitCode};}catch(error){await proc.kill().catch(()=>{});await Promise.allSettled(jobs);throw error;}}
    async withSync(work,signal){GJ.checkAbort(signal);const sync=await this.adb.sync();this.sessions.add(sync);let abortReject;const aborted=new Promise((_,reject)=>abortReject=reject);const stop=()=>{void sync.dispose().catch(()=>{});abortReject(signal.reason||GJ.abortError());};signal?.addEventListener('abort',stop,{once:true});let error;try{GJ.checkAbort(signal);return await Promise.race([work(sync),aborted]);}catch(e){error=e;throw e;}finally{signal?.removeEventListener('abort',stop);this.sessions.delete(sync);try{await sync.dispose();}catch(e){if(!error)throw e;}}}
    async write(file,path,{signal,onProgress}={}){return this.withSync(async sync=>{let done=0;const source=file.stream().pipeThrough(new TransformStream({transform(chunk,controller){GJ.checkAbort(signal);done+=chunk.length;onProgress?.(done,file.size);controller.enqueue(chunk);}}));await sync.write({filename:path,file:source,permission:0o644,mtime:Math.floor((file.lastModified||Date.now())/1000)});onProgress?.(file.size,file.size);},signal);}
    async read(path,{signal,onProgress}={}){return this.withSync(async sync=>{let total=0;try{total=Number((await sync.lstat(path)).size);}catch{}const bytes=await collect(sync.read(path),{limit:768*1024*1024,progress:done=>{GJ.checkAbort(signal);onProgress?.(done,total);}});return new Blob([bytes],{type:/\.png$/i.test(path)?'image/png':/\.apk$/i.test(path)?'application/vnd.android.package-archive':'application/octet-stream'});},signal);}
    async control(service){if(!/^(?:tcpip:\d+|usb:|reboot:[\w-]*)$/.test(service))throw new Error('无效的设备服务');const socket=await this.adb.createSocket(service);try{return new TextDecoder().decode(await collect(socket.readable,{limit:1024*1024}));}finally{await socket.close().catch(()=>{});}}
    async reboot(mode){if(mode==='poweroff'){try{await this.exec('reboot -p');}catch(error){if(this.connected)throw error;}return;}const socket=await this.adb.createSocket('reboot:'+mode);await socket.close().catch(()=>{});}
    async close(){if(this.closing)return this.closing;this.connected=false;this.closing=(async()=>{for(const process of this.processes)await Promise.resolve(process.kill()).catch(()=>{});this.processes.clear();for(const s of this.sessions)await s.dispose().catch(()=>{});try{await this.adb.close();}finally{await this.closeOwned();}})();return this.closing;}
  }
  async function authenticate(connection,serial,closeOwned,signal){GJ.checkAbort(signal);let cancelled=false,rejectCancel;const cancelPromise=new Promise((_,reject)=>rejectCancel=reject);const stop=()=>{cancelled=true;void closeOwned().catch(()=>{});rejectCancel(signal?.reason||new Error('认证超时，请在手机上允许 USB 调试后重试'));};const timer=setTimeout(stop,60000);signal?.addEventListener('abort',stop,{once:true});const auth=adbLib.AdbDaemonTransport.authenticate({serial,connection,credentialStore:new CredentialStore('搞机工具箱')});auth.then(transport=>{if(cancelled)void transport.close().catch(()=>{});},()=>{});try{const transport=await Promise.race([auth,cancelPromise]);GJ.checkAbort(signal);return new adbLib.Adb(transport);}catch(error){cancelled=true;await closeOwned().catch(()=>{});throw error;}finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}}
  async function connectUsb({device,signal}={}){if(!manager)throw new Error('当前浏览器不支持 WebUSB，请使用 Chrome / Edge 并通过 HTTPS 或 localhost 打开');const selected=device||await manager.requestDevice();if(!selected)throw new DOMException('未选择设备','AbortError');GJ.checkAbort(signal);const close=()=>selected.raw.close();try{const connection=await selected.connect();GJ.checkAbort(signal);const adb=await authenticate(connection,selected.serial,close,signal);return new Driver(adb,{serial:selected.serial,label:selected.name||selected.serial,closeOwned:close});}catch(error){await close().catch(()=>{});if(error.name==='DeviceBusyError'||/already.*use|claim.*interface/i.test(error.message))throw new Error('当前adb接口被占用，请在任务管理器中手动结束adb.exe进程');throw error;}}
  function supportsWireless() {
    return location.protocol==='http:'&&['127.0.0.1','localhost'].includes(location.hostname);
  }

  function wirelessAddress(value,defaultPort) {
    const match=value.trim().match(/^((?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:.]+\])(?::(\d{1,5}))?$/i);
    const port=Number(match?.[2]??defaultPort);
    if(match&&port>=1&&port<=65535){
      try{
        const host=new URL('http://'+match[1]).hostname;
        if(match[1].startsWith('[')||host===match[1])return host+':'+port;
      }catch{}
    }
    throw new Error('请输入有效的手机 IP 地址和端口，例如 192.168.1.100:37127');
  }

  async function bridgeRequest(path,signal) {
    let response;
    try{
      response=await fetch(path,{method:'POST',signal});
    }catch(error){
      GJ.checkAbort(signal);
      throw new Error('无法访问本机 ADB 桥接，请确认 node server.cjs 正在运行',{cause:error});
    }
    if(response.status===204)return;
    const result=await response.json().catch(()=>null);
    if(response.ok&&Array.isArray(result))return result;
    throw new Error(result?.error||'请通过本项目的 node server.cjs 启动页面以使用无线 ADB');
  }

  async function byteChannel(route,signals) {
    signals.forEach(GJ.checkAbort);
    const socket=new WebSocket('ws://'+location.host+route);
    socket.binaryType='arraybuffer';
    let controller,resolveClosed,rejectClosed,markOpen,failOpen,finished=false;
    const opened=new Promise((resolve,reject)=>{markOpen=resolve;failOpen=reject;});
    const closed=new Promise((resolve,reject)=>{resolveClosed=resolve;rejectClosed=reject;});
    closed.catch(()=>{});
    const abort=event=>close(event.target.reason||GJ.abortError());
    function finish(error,streamCancelled=false) {
      if(finished)return;
      finished=true;
      for(const signal of signals)signal.removeEventListener('abort',abort);
      failOpen(error||new Error('本机 ADB 桥接已关闭'));
      if(error){controller.error(error);rejectClosed(error);}
      else{
        if(!streamCancelled)controller.close();
        resolveClosed();
      }
    }
    function close(error) {
      finish(error);
      socket.close();
    }
    const readable=new ReadableStream({
      start(c){controller=c;},
      cancel(){
        finish(null,true);
        socket.close();
      }
    });
    for(const signal of signals)signal.addEventListener('abort',abort,{once:true});
    socket.onopen=markOpen;
    socket.onmessage=event=>{
      if(finished)return;
      if(!(event.data instanceof ArrayBuffer)){close(new Error('本机 ADB 桥接返回了非二进制数据'));return;}
      controller.enqueue(new Uint8Array(event.data));
    };
    socket.onerror=()=>close(new Error('无法打开本机 ADB 通道，请检查本机服务'));
    socket.onclose=event=>finish(event.code===1000||event.code===1005?null:new Error(event.reason||'本机 ADB 通道已断开'));
    await opened;
    const writable=new streamLib.MaybeConsumable.WritableStream({
      async write(bytes){
        while(socket.readyState===WebSocket.OPEN&&socket.bufferedAmount>1024*1024)await GJ.sleep(10);
        if(socket.readyState!==WebSocket.OPEN)throw new Error('本机 ADB 通道已关闭');
        socket.send(bytes);
      },
      close:()=>close(),
      abort:()=>close()
    });
    return {readable,writable,closed,close:()=>close()};
  }

  async function withServer(signal,work,{server='wireless',start=true,keepOpen=false}={}) {
    if(!supportsWireless())throw new Error('请通过本机 node server.cjs 启动页面以使用无线 ADB');
    GJ.checkAbort(signal);
    await load();
    GJ.checkAbort(signal);
    const setup=new AbortController();
    const cancel=()=>setup.abort(signal.reason||GJ.abortError());
    const timeout=setTimeout(()=>setup.abort(new Error('ADB 操作超时，请检查设备和本机 ADB 服务后重试')),start?35000:6000);
    signal?.addEventListener('abort',cancel,{once:true});
    const channels=new Set();
    const close=()=>{
      for(const channel of channels)channel.close();
      channels.clear();
      setup.abort(GJ.abortError());
    };
    try{
      if(start)await bridgeRequest('/api/adb/start',setup.signal);
      const client=new adbLib.AdbServerClient({
        async connect(options){
          const signals=[setup.signal];
          if(options?.signal)signals.push(options.signal);
          const channel=await byteChannel(serverRoutes[server],signals);
          channels.add(channel);
          const forget=()=>channels.delete(channel);
          channel.closed.then(forget,forget);
          return channel;
        }
      });
      const result=await work(client,setup.signal,close);
      GJ.checkAbort(setup.signal);
      if(!keepOpen)close();
      return result;
    }catch(error){
      const reason=setup.signal.aborted?setup.signal.reason:error;
      close();
      throw reason;
    }finally{
      clearTimeout(timeout);
      signal?.removeEventListener('abort',cancel);
    }
  }

  async function listLocalDevices({signal}={}) {
    const servers=await bridgeRequest('/api/adb/servers',
      AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]));
    const results=await Promise.allSettled(servers.filter(server=>Object.hasOwn(serverRoutes,server)).map(server=>
      withServer(signal,async client=>(await client.getDevices(deviceStates)).map(device=>({...device,server})),{server,start:false})
    ));
    GJ.checkAbort(signal);
    const loaded=results.filter(result=>result.status==='fulfilled');
    if(!loaded.length&&results.length)throw results[0].reason;
    return {devices:loaded.flatMap(result=>result.value),partial:loaded.length<results.length};
  }

  async function openAdbDevice(client,device,kind,closeOwned) {
    const adb=await client.createAdb({transportId:device.transportId});
    return new Driver(adb,{serial:device.serial,label:device.model||device.serial,kind,closeOwned});
  }

  async function connectLocalDevice({device,signal}) {
    return withServer(signal,async(client,_,close)=>{
      const selected=(await client.getDevices(deviceStates)).find(entry=>entry.serial===device.serial);
      if(selected?.state!=='device')throw new Error('所选设备已离线或未授权，请刷新本机设备列表');
      return openAdbDevice(client,selected,'local',close);
    },{server:device.server,start:false,keepOpen:true});
  }

  async function pairWireless({address,code,signal}) {
    const target=wirelessAddress(address);
    if(!/^\d{6}$/.test(code))throw new Error('请输入手机显示的 6 位配对码');
    await withServer(signal,async(client,setupSignal)=>{
      try{await client.wireless.pair(target,code);}
      catch(error){
        GJ.checkAbort(setupSignal);
        throw new Error('配对失败，请确认配对弹窗仍打开、地址和配对码正确，并检查 Platform-Tools 版本',{cause:error});
      }
    });
  }

  async function connectWireless({address,signal}) {
    const target=wirelessAddress(address,5555);
    return withServer(signal,async(client,setupSignal,close)=>{
      try{await client.wireless.connect(target);}
      catch(error){
        if(!(error instanceof adbLib.AdbServerClient.AlreadyConnectedError)){
          GJ.checkAbort(setupSignal);
          throw new Error('连接 '+target+' 失败，请检查手机无线调试主页的连接端口、配对状态和 Wi-Fi 网络',{cause:error});
        }
      }
      const deadline=Date.now()+10000;
      let selected;
      do{
        selected=(await client.getDevices(['device','unauthorized','offline'])).find(device=>device.serial===target);
        if(selected?.state==='device')return openAdbDevice(client,selected,'wireless',close);
        await GJ.sleep(300,setupSignal);
      }while(Date.now()<deadline);
      throw new Error(selected?.state==='unauthorized'?'请在手机上允许调试，或重新配对':'设备尚未上线，请确认手机仍开启无线调试后重试');
    },{keepOpen:true});
  }
  async function clearKeys(){return new Promise((resolve,reject)=>{const req=indexedDB.deleteDatabase('Tango');req.onsuccess=()=>resolve();req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('密钥数据库被其他标签页占用，请关闭其他 WebADB 页面后重试'));});}
  return {load,devices,connectUsb,supportsWireless,listLocalDevices,connectLocalDevice,pairWireless,connectWireless,clearKeys,Driver};
})();

export {GJTransport};
