/*
SPDX-FileCopyrightText: 2026 晨钟酱Official
SPDX-License-Identifier: GPL-3.0-only
See LICENSE for the full license text.
*/
import {GJ} from './core.js';

const GJGamepad=(()=>{
  const descriptor=[
    0x05,0x01, 0x09,0x05, 0xa1,0x01, // Generic Desktop / Game Pad
    0x05,0x09, 0x19,0x01, 0x29,0x10, // Button usages 1–16
    0x15,0x00, 0x25,0x01, 0x75,0x01, 0x95,0x10, 0x81,0x02,
    0x05,0x01, 0x09,0x30, 0x09,0x31, 0x09,0x32, 0x09,0x35, // X, Y, Z, Rz
    0x15,0x81, 0x25,0x7f, 0x75,0x08, 0x95,0x04, 0x81,0x02,
    0x09,0x39, 0x15,0x00, 0x25,0x07, 0x35,0x00, 0x46,0x3b,0x01, // Hat switch (degrees)
    0x65,0x14, 0x75,0x04, 0x95,0x01, 0x81,0x42, // 8 is the null position
    0x65,0x00, 0x75,0x04, 0x95,0x01, 0x81,0x03,
    0xc0
  ];
  const buttonBits={a:0,b:1,x:3,y:4,l1:6,r1:7,l2:8,r2:9,select:10,start:11,l3:13,r3:14};
  const keys={
    ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',
    KeyW:'stick-up',KeyA:'stick-left',KeyS:'stick-down',KeyD:'stick-right',
    KeyT:'right-stick-up',KeyF:'right-stick-left',KeyG:'right-stick-down',KeyH:'right-stick-right',
    KeyJ:'a',KeyK:'b',KeyU:'x',KeyI:'y',KeyQ:'l1',KeyE:'r1',Digit1:'l2',Digit3:'r2',
    Backspace:'select',Enter:'start',KeyC:'l3',KeyN:'r3'
  };
  const encoder=new TextEncoder();

  class Controller {
    constructor({page,controls,toggle,status}){
      this.page=page;
      this.controls=controls;
      this.toggleButton=toggle;
      this.status=status;
      this.session=null;
      this.pressed=new Map();
      this.buttons=[...controls.querySelectorAll('[data-gamepad-control]')];
      this.sticks=[...controls.querySelectorAll('[data-gamepad-stick]')].map(element=>({element,pointer:null,x:0,y:0}));
      for(const button of this.buttons)this.bindButton(button);
      for(const stick of this.sticks)this.bindStick(stick);
      window.addEventListener('keydown',event=>this.key(event,true));
      window.addEventListener('keyup',event=>this.key(event,false));
      window.addEventListener('blur',()=>this.release());
      document.addEventListener('visibilitychange',()=>{if(document.hidden)this.release();});
    }

    render(message,error=false){
      this.controls.disabled=!this.session?.ready;
      this.toggleButton.textContent=this.session?(this.session.ready?'关闭手柄':'取消启动'):'启用手柄';
      this.status.textContent=message;
      this.status.classList.toggle('error',error);
    }

    async toggle(driver){
      if(this.session){this.close();return;}
      if(!driver?.connected)return;
      const abort=new AbortController();
      const session={abort,process:null,writer:null,ready:false,queue:[],sending:false,last:''};
      const name='GJ Gamepad '+crypto.randomUUID().slice(0,8);
      this.session=session;
      this.render('正在向 Android 注册手柄…');
      let diagnostics='';
      const timeout=setTimeout(()=>{
        if(this.session===session)this.close(diagnostics.trim()||'Android 未识别虚拟手柄，请检查设备的 hid 支持。',true);
      },10000);
      try{
        const process=await driver.openProcess('hid -',abort.signal);
        if(this.session!==session){await process.kill().catch(()=>{});return;}
        session.process=process;
        const decoder=new TextDecoder();
        void process.stdout.pipeTo(new WritableStream()).catch(()=>{});
        void process.stderr.pipeTo(new WritableStream({
          write(chunk){diagnostics=(diagnostics+decoder.decode(chunk,{stream:true})).slice(-300);}
        })).catch(()=>{});
        const ended=()=>{
          if(this.session===session)this.close(diagnostics.trim()||'Android 已结束手柄会话，请检查设备是否支持 hid。',true);
        };
        process.exited.then(ended,ended);
        session.writer=process.stdin.getWriter();
        await this.write(session,{command:'register',name,vid:0,pid:1,bus:'usb',descriptor});
        while(true){
          const result=await driver.exec('dumpsys input | grep -F '+GJ.quote(name),{signal:abort.signal});
          if(result.exitCode===0&&result.stdout.includes(name))break;
          await GJ.sleep(250,abort.signal);
        }
        if(this.session!==session)return;
        session.ready=true;
        this.render('手柄已启用。请在手机上打开支持手柄的应用。');
        this.page.focus();
        this.sendReport();
      }catch(error){
        if(this.session===session)this.close(diagnostics.trim()||error.message,true);
      }finally{clearTimeout(timeout);}
    }

    write(session,data){
      return session.writer.write(encoder.encode(JSON.stringify({id:1,...data})+'\n'));
    }

    close(message='手柄未启用',error=false){
      const session=this.session;
      this.session=null;
      this.release();
      this.render(message,error);
      if(!session)return;
      session.abort.abort(GJ.abortError());
      void session.process?.kill().catch(()=>{});
    }

    setPressed(source,control,pressed){
      if(!this.session?.ready)return;
      if(pressed)this.pressed.set(source,control);
      else if(!this.pressed.delete(source))return;
      this.sendReport();
    }

    key(event,pressed){
      if(!this.session?.ready)return;
      const control=keys[event.code];
      if(!control)return;
      if(pressed&&(event.altKey||event.ctrlKey||event.metaKey||
        event.target.closest?.('input, textarea, select, [contenteditable=true]')||
        event.code==='Enter'&&event.target.closest?.('button')))return;
      if(!pressed&&!this.pressed.has(event.code))return;
      event.preventDefault();
      if(!event.repeat)this.setPressed(event.code,control,pressed);
    }

    bindButton(button){
      const control=button.dataset.gamepadControl;
      button.addEventListener('pointerdown',event=>{
        if(event.button!==0||!this.session?.ready)return;
        button.setPointerCapture(event.pointerId);
        this.setPressed(event.pointerId,control,true);
      });
      for(const type of ['pointerup','pointercancel','lostpointercapture']){
        button.addEventListener(type,event=>this.setPressed(event.pointerId,control,false));
      }
      button.addEventListener('click',event=>{
        if(event.detail!==0||!this.session?.ready)return;
        const source=Symbol(control);
        this.setPressed(source,control,true);
        setTimeout(()=>this.setPressed(source,control,false),60);
      });
    }

    bindStick(stick){
      const {element}=stick;
      const move=event=>{
        if(event.pointerId!==stick.pointer)return;
        const rect=element.getBoundingClientRect();
        const radius=Math.min(rect.width,rect.height)*0.34;
        const x=(event.clientX-rect.left-rect.width/2)/radius;
        const y=(event.clientY-rect.top-rect.height/2)/radius;
        const scale=127/Math.max(1,Math.hypot(x,y));
        stick.x=Math.round(x*scale);
        stick.y=Math.round(y*scale);
        this.sendReport(true);
      };
      element.addEventListener('pointerdown',event=>{
        if(event.button!==0||stick.pointer!==null||!this.session?.ready)return;
        stick.pointer=event.pointerId;
        element.setPointerCapture(event.pointerId);
        move(event);
      });
      element.addEventListener('pointermove',move);
      for(const type of ['pointerup','pointercancel','lostpointercapture']){
        element.addEventListener(type,event=>{
          if(stick.pointer!==event.pointerId)return;
          stick.pointer=null;
          stick.x=stick.y=0;
          this.sendReport();
        });
      }
    }

    release(){
      this.pressed.clear();
      for(const stick of this.sticks){
        const pointer=stick.pointer;
        stick.pointer=null;
        stick.x=stick.y=0;
        if(pointer!==null&&stick.element.hasPointerCapture(pointer))stick.element.releasePointerCapture(pointer);
      }
      this.sendReport();
    }

    sendReport(motion=false){
      const pressed=new Set(this.pressed.values());
      for(const button of this.buttons)button.classList.toggle('held',pressed.has(button.dataset.gamepadControl));
      const direction=(positive,negative)=>Number(pressed.has(positive))-Number(pressed.has(negative));
      const x=direction('right','left'),y=direction('down','up');
      const hat=x||y?(Math.round(Math.atan2(x,-y)/(Math.PI/4))+8)%8:8;
      const axes=this.sticks.flatMap((stick,index)=>{
        const keyGroup=index===0?'stick-':'right-stick-';
        const keyX=direction(keyGroup+'right',keyGroup+'left'),keyY=direction(keyGroup+'down',keyGroup+'up');
        const keyScale=keyX&&keyY?90:127;
        const axisX=stick.pointer===null?keyX*keyScale:stick.x;
        const axisY=stick.pointer===null?keyY*keyScale:stick.y;
        stick.element.style.setProperty('--stick-x',axisX/1.27+'%');
        stick.element.style.setProperty('--stick-y',axisY/1.27+'%');
        return [axisX&255,axisY&255];
      });
      const session=this.session;
      if(!session?.ready)return;
      let mask=0;
      for(const control of pressed)if(Object.hasOwn(buttonBits,control))mask|=1<<buttonBits[control];
      const report=[mask&255,mask>>8,...axes,hat];
      const signature=report.join(',');
      if(signature===session.last)return;
      session.last=signature;
      const packet={report,motion};
      if(motion&&session.queue.at(-1)?.motion)session.queue[session.queue.length-1]=packet;
      else session.queue.push(packet);
      if(session.queue.length>96){this.close('手柄连接响应过慢，请重新启用。',true);return;}
      if(!session.sending)void this.flush(session);
    }

    async flush(session){
      session.sending=true;
      try{
        while(this.session===session&&session.queue.length){
          const {report}=session.queue.shift();
          await this.write(session,{command:'report',report});
        }
      }catch(error){
        if(this.session===session)this.close('手柄输入发送失败。'+error.message,true);
      }finally{session.sending=false;}
    }
  }
  return {Controller};
})();

export {GJGamepad};
