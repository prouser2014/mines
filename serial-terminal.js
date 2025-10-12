/** serial-terminal.js Serial-порт для подключения "Изморози". */
(() => {
  // Вспомогательные функции
  const stamp = () => new Date().toLocaleTimeString("ru-RU", { hour12: false });
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // DOM-переменные
  const modal        = document.getElementById("serialModal");
  if (!modal) return;

  const titleNode    = document.getElementById("serialModalTitle");
  const termBlock    = document.getElementById("serialTerminalBlock");
  const terminalView = document.getElementById("terminalView");
  const termLog      = document.getElementById("serialTerminal");
  const termForm     = document.getElementById("serialForm");
  const termInput    = document.getElementById("serialInput");
  const settingsView = document.getElementById("transceiverSettingsBlock");

  const actions      = document.getElementById("serialActionsContainer");
  const connectBtn   = document.getElementById("serialConnectBtn");
  const settingsBtn  = document.getElementById("transceiverSettingsBtn");
  const deviceBtn    = document.getElementById("deviceSettingsBtn");

  // Поля настроек
  const elGroup = document.getElementById('groupNumber');
  const elNode  = document.getElementById('nodeNumber');
  const elSF    = document.getElementById('spreadFactor');
  const elFR    = document.getElementById('freqMHz');
  const elPwr   = document.getElementById('txPowerW'); // используем как dBm: 5..20
  const elRelay = document.getElementById('relayEnabled');

  // Расположение и внешний вид панели управления
  if (actions && termBlock) {
    actions.id = 'serialCtrlRow';
    if (terminalView && actions !== terminalView.previousElementSibling) {
      termBlock.insertBefore(actions, terminalView);
    }
  }
  const normalizeBtn = (btn, cls) => {
    if (!btn) return;
    btn.classList.remove('menu-btn');
    btn.removeAttribute('style');
    btn.classList.add(cls);
  };
  normalizeBtn(connectBtn, 'btn-connect');
  normalizeBtn(settingsBtn, 'btn');
  normalizeBtn(deviceBtn,  'btn-connect');

  // Блок настроек скрыт до соединения с "Изморозью"
  if (settingsView) settingsView.hidden = true;

  // Лимиты ТТХ "Изморози" 
  if (elSF) {
    elSF.min='7'; elSF.max='12'; elSF.step='1';
    elSF.addEventListener('change', () => { elSF.value = String(clamp(+elSF.value || 0, 7, 12)); });
  }
  if (elFR) {
    elFR.min='433'; elFR.max='470'; elFR.step='0.01';
    elFR.addEventListener('change', () => { elFR.value = (clamp(+elFR.value || 0, 433, 470)).toFixed(2); });
  }
  if (elPwr) {
    elPwr.min='5'; elPwr.max='20'; elPwr.step='1';
    elPwr.addEventListener('change', () => { elPwr.value = String(clamp(+elPwr.value || 0, 5, 20)); });
  }

  // Логирование терминала
  function log(msg){
    if (!termLog) return;
    const line = document.createElement("div");
    const t = document.createElement("span");
    t.className = "time-stamp";
    t.textContent = `[${stamp()}] `;
    const m = document.createElement("span");
    m.textContent = String(msg);
    line.appendChild(t); line.appendChild(m);
    termLog.appendChild(line);
    termLog.scrollTop = termLog.scrollHeight;
  }

  // Анализ и обработка сообщений от "Изморози"
  function isManagersInitialized(){ return !!(window.minesManager?.mines && window.nodesManager?.nodes); }
  function nodeMatches(name,node){
    const nm=String(node?.name||"").trim();
    const fb=String(node?.id??"");
    return (nm?nm:fb)===String(name);
  }
  function applyChannelStatesToMines(node,pairs){
    const mines = window.minesManager?.mines || [];
    let updated=false;
    for (const [ch,st] of pairs){
      const mine=mines.find(m=>m.assignedNodeId===node.id && Number(m.channel)===ch);
      if (!mine) continue;
      window.minesManager.setMineState(mine, st===1?"armed":"disarmed");
      updated=true;
    }
    if (updated && typeof window.updateMineList==='function') window.updateMineList();
  }
  function tryParseAndFillConfig(lineRaw){
    let line=String(lineRaw||"").replace(/^\[[^\]]*]\s*/,'').replace(/^@/,'').trim(), m;
    if (m=line.match(/^GroupID:\s*(\d+)\s*$/i)) { if (elGroup) elGroup.value=Number(m[1]); return true; }
    if (m=line.match(/^CallID:\s*(\d+)\s*$/i))  { if (elNode ) elNode.value =Number(m[1]); return true; }
    if (m=line.match(/^SF:\s*(\d+)\s*$/i))     { if (elSF  ) elSF.value  =String(clamp(+m[1],7,12)); return true; }
    if (m=line.match(/^FR:\s*([0-9]+(?:\.[0-9]+)?)\s*MHz\s*$/i)) { if (elFR) elFR.value=(clamp(+m[1],433,470)).toFixed(2); return true; }
    if (m=line.match(/^TX\s*Power:\s*([0-9]+(?:\.[0-9]+)?)\s*dBm\s*$/i)){ if (elPwr) elPwr.value=String(clamp(+m[1],5,20)); return true; }
    if (m=line.match(/^Retransmission:\s*(\d+)\s*$/i)){ if (elRelay) elRelay.checked=!!+m[1]; return true; }
    return false;
  }
  function processMessage(msg){
    const s=String(msg||"").trim().replace(/\r?\n$/,'');
    if (tryParseAndFillConfig(s)) return;
    if (!isManagersInitialized()) return;

    // Протокол: "<nodeName>;s;1" — все каналы node -> "set"
    const mSet = s.match(/^([^\s;]+);s;1$/);
    if (mSet){
      const name=mSet[1]; const nodes=window.nodesManager?.nodes||[];
      for (const node of nodes) if (nodeMatches(name,node)) {
        const mines=window.minesManager?.mines||[];
        for (const mine of mines) if (mine.assignedNodeId===node.id) window.minesManager.setMineState(mine,"set");
      }
      return;
    }

    // Парсинг входящих сообщений
    const mMulti = s.match(/^([^\s;]+);(.+)$/);
    if (mMulti){
      const name=mMulti[1], tail=mMulti[2].split(";").map(x=>x.trim()).filter(Boolean);
      if (tail.length>=2 && tail.length%2===0){
        const pairs=[];
        for (let i=0;i<tail.length;i+=2){
          const ch=+tail[i], v=tail[i+1];
          if (!Number.isFinite(ch) || (v!=="0"&&v!=="1")) return;
          pairs.push([ch,+v]);
        }
        const nodes=window.nodesManager?.nodes||[];
        for (const node of nodes) if (nodeMatches(name,node)) applyChannelStatesToMines(node,pairs);
      }
    }
  }

  // Состояние подключения
  let isConnected=false;

  // Пользовательский интерфейс 
  function updateActionsUI(){
    if (connectBtn){
      connectBtn.textContent = isConnected ? "Отключить" : "Подключить";
      connectBtn.classList.toggle("connected", isConnected);
    }
    if (settingsBtn){
      settingsBtn.hidden = !isConnected;
      settingsBtn.textContent = (settingsView && !settingsView.hidden)
        ? "Принять изменения" : "Настройки приёмопередатчика";
    }
    if (deviceBtn){
      deviceBtn.classList.toggle("connected", isConnected);
    }
  }

  function toSettingsView(){
    if (terminalView) terminalView.hidden = true;
    if (settingsView) settingsView.hidden = false;
    if (titleNode)    titleNode.textContent='Настройки приёмопередатчика';
    updateActionsUI();
  }
  function toTerminalView(){
    if (settingsView) settingsView.hidden = true;
    if (terminalView) terminalView.hidden = false;
    if (titleNode)    titleNode.textContent='Терминал';
    updateActionsUI();
  }

  // Обработка входящих данных
  let rxBuffer = "";
  function onChunk(str){
    if (typeof str!=='string') return;
    rxBuffer += str;
    const parts = rxBuffer.split(/\r?\n/); rxBuffer = parts.pop();
    for (const line of parts) {
      if (!line) continue;
      log(line);
      try { processMessage(line); } catch (e) { console.debug('[serial][processMessage]', e); }
    }
  }

  // ===== Поддержка различных платформ =====

  // Web Serial (Для подключения к ПК-версии)
  let port=null, reader=null, readAbort=null;

  async function startReadLoopWeb(){
    if (!port) return;
    readAbort = new AbortController();
    const textDecoder = new TextDecoderStream();
    const readable = port.readable.pipeThrough(textDecoder);
    reader = readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) onChunk(value);
      }
    } catch (e) {
      console.debug('[serial][web][readLoop]', e);
      await safeCloseWeb();
    } finally {
      try{ reader?.releaseLock?.(); }catch(e){ console.debug('[serial][web][releaseLock]', e); }
      reader = null;
    }
  }
  async function connectWeb(){
    try{
      if(!navigator.serial){
        alert("Браузер без Web Serial. Откройте сайт по https:// или http://localhost (Chrome/Edge) — либо используйте Android с USB-плагином.");
        return;
      }
      port = await navigator.serial.requestPort();
      await port.open({ baudRate:115200 });

      isConnected = true;
      window.isSerialConnected = true;
      window.dispatchEvent(new Event('serial-connection-change'));
      updateActionsUI();
      log("Устройство радиоуправления подключено.");

      await startReadLoopWeb();
    }catch(e){
      console.debug('[serial][web][connect]', e);
      log("Не удалось открыть порт: " + (e?.message || String(e)));
      await safeCloseWeb();
    }
  }
  async function safeCloseWeb(){
    try{ readAbort?.abort?.(); }catch(e){ console.debug('[serial][web][abort]', e); }
    try{ reader && await reader.cancel(); }catch(e){ console.debug('[serial][web][cancel]', e); }
    try{ reader?.releaseLock?.(); }catch(e){ console.debug('[serial][web][releaseLock2]', e); }
    reader = null;
    try{ await port?.close?.(); }catch(e){ console.debug('[serial][web][close]', e); }
    port = null;

    isConnected = false;
    window.isSerialConnected = false;
    window.dispatchEvent(new Event('serial-connection-change'));
    updateActionsUI();
    toTerminalView();
    log("Устройство радиоуправления отключено.");
  }

  // Взаимодействие с USB-устройством на платформе Android
  const getCapUsb = () => window.Capacitor?.Plugins?.UsbSerial || null;
  const getCdvUsb = () => window.cordova?.plugins?.usbserial || null;

  function isAndroid() {
    const cap = window.Capacitor;
    const ua = navigator.userAgent || "";
    return !!(cap?.isNativePlatform?.() || cap?.platform === 'android' || /Android/i.test(ua));
  }
  function waitDeviceready(timeoutMs=5000){
    return new Promise(res=>{
      if (!isAndroid()) return res(true);
      let done=false;
      const timer=setTimeout(()=>{ if(!done) res(false); }, timeoutMs);
      document.addEventListener('deviceready', ()=>{ done=true; clearTimeout(timer); res(true); }, {once:true});
      // если уже готово
      setTimeout(()=>{ if(!done) res(true); }, 0);
    });
  }

  async function connectAndroid(){
    await waitDeviceready();

    const Cap = getCapUsb();
    if (Cap) {
      try{
        let listResp = await Cap.connectedDevices();
        let list = Array.isArray(listResp) ? listResp : (listResp?.data || []);
        if (!list.length) {
          try { await Cap.requestPermission(); } catch (e) { console.debug('[serial][cap][permission]', e); }
          listResp = await Cap.connectedDevices();
          list = Array.isArray(listResp) ? listResp : (listResp?.data || []);
        }
        if (!list.length) { alert('Подключите устройство по OTG и подтвердите доступ.'); return; }
        const dev = list[0];
        const deviceId = dev?.deviceId ?? dev?.id ?? dev;

        await Cap.openSerial({
          deviceId, portNum:0,
          baudRate:115200, dataBits:8, stopBits:1, parity:0,
          dtr:true, rts:true, sleepOnPause:false
        });

        await Cap.registerReadCall(({success, data})=>{
          if (success === false) return;
          if (data) onChunk(String(data));
        });

        isConnected=true; window.isSerialConnected=true; window.dispatchEvent(new Event('serial-connection-change'));
        updateActionsUI(); log("Устройство радиоуправления подключено.");
        return;
      } catch (e) {
        console.debug('[serial][cap][connect]', e);
        alert('Не удалось открыть USB-порт (Capacitor).');
        return;
      }
    }

    const cdv = getCdvUsb();
    if (cdv) {
      try{
        let devices = await new Promise((res, rej)=> cdv.getDeviceList(res, rej));
        if (!Array.isArray(devices) || !devices.length) {
          try { await new Promise((res, rej)=> cdv.requestPermission({}, res, rej)); }
          catch(e){ console.debug('[serial][cdv][permission]', e); }
          devices = await new Promise((res, rej)=> cdv.getDeviceList(res, rej));
        }
        const dev = Array.isArray(devices) && devices.length ? devices[0] : null;
        const opts = { baudRate:115200, dataBits:8, stopBits:1, parity:0, dtr:true, rts:true, driver:'auto' };
        if (dev?.vid && dev?.pid){ opts.vid=dev.vid; opts.pid=dev.pid; }

        await new Promise((res, rej)=> cdv.open(opts, res, rej));
        cdv.registerReadCallback((data)=>{
          try {
            if (typeof data === 'string') onChunk(data);
            else if (data instanceof ArrayBuffer) onChunk(new TextDecoder().decode(new Uint8Array(data)));
            else if (data?.data && typeof data.data === 'string') onChunk(data.data);
          } catch(e){ console.debug('[serial][cdv][onData]', e); }
        }, ()=>{}, (e)=>console.debug('[serial][cdv][registerReadCallback]', e));

        isConnected=true; window.isSerialConnected=true; window.dispatchEvent(new Event('serial-connection-change'));
        updateActionsUI(); log("Устройство радиоуправления подключено.");
        return;
      } catch (e) {
        console.debug('[serial][cdv][connect]', e);
        alert('Не удалось открыть USB-порт (Cordova).');
        return;
      }
    }

    alert('USB-Serial плагин не найден. Убедитесь, что он подключён в приложении.');
  }

  async function sendAndroid(data){
    const s=String(data??'');
    const Cap=getCapUsb();
    if (Cap){ await Cap.writeSerial({data:s}); log(s.trim()); return; }
    const cdv=getCdvUsb();
    if (cdv){ await new Promise((res, rej)=> cdv.write(s, res, rej)); log(s.trim()); return; }
    alert('USB-API недоступен');
  }

  async function disconnectAndroid(){
    try{
      const Cap=getCapUsb();
      if (Cap) { try { await Cap.closeSerial(); } catch(e){ console.debug('[serial][cap][close]', e); } }
      const cdv=getCdvUsb();
      if (cdv) { try { await new Promise((res, rej)=> cdv.close(res, rej)); } catch(e){ console.debug('[serial][cdv][close]', e); } }
    } finally {
      isConnected=false; window.isSerialConnected=false; window.dispatchEvent(new Event('serial-connection-change'));
      updateActionsUI(); toTerminalView(); log("Устройство радиоуправления отключено.");
    }
  }

  // Единый интерфейс для управления подключением
  async function connect(){ return isAndroid() ? connectAndroid() : connectWeb(); }
  async function disconnect(){ return isAndroid() ? disconnectAndroid() : safeCloseWeb(); }
  async function send(data){
    if (!isConnected){ log("Нет открытого порта"); return; }
    if (isAndroid()) return sendAndroid(data);
    try{
      const w = port.writable.getWriter();
      await w.write(new TextEncoder().encode(String(data)));
      w.releaseLock();
      log(String(data).trim());
    }catch(e){
      console.debug('[serial][web][write]', e);
      await safeCloseWeb();
    }
  }

  // Обработчики Кнопок и форм
  if (deviceBtn) deviceBtn.addEventListener('click', ()=> modal.classList.add('show'));
  modal.addEventListener('click', (e)=>{ if (e.target===modal) modal.classList.remove('show'); });

  if (connectBtn) connectBtn.onclick = async ()=>{ if (!isConnected) await connect(); else await disconnect(); };

  if (termForm) termForm.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const val = (termInput?.value ?? "").trim();
    if (!val) return;
    await send(val + "\n");
    termInput.value = "";
  });

  if (settingsBtn) settingsBtn.addEventListener('click', async ()=>{
    const inSettings = (settingsView && !settingsView.hidden);
    if (inSettings) {
      const group = Number(elGroup?.value ?? 0);
      const node  = Number(elNode ?.value ?? 0);
      const sf    = clamp(Number(elSF ?.value ?? 0), 7, 12);
      const fr    = clamp(Number(elFR ?.value ?? 0), 433, 470);
      const pwr   = clamp(Number(elPwr ?.value ?? 0), 5, 20); // dBm
      const rly   = (elRelay && elRelay.checked) ? 1 : 0;

      if (elSF)  elSF.value  = String(sf);
      if (elFR)  elFR.value  = fr.toFixed(2);
      if (elPwr) elPwr.value = String(pwr);

      try{
        await send(`set_call ${node}\n`);
        await send(`set_group ${group}\n`);
        await send(`set_fr ${fr.toFixed(2)}\n`);
        await send(`set_sf ${sf}\n`);
        await send(`set_retrans ${rly}\n`);
        await send(`set_pwr ${pwr}\n`);
        alert('Настройки приёмопередатчика сохранены');
        toTerminalView();
        updateActionsUI();
      }catch(e){
        console.debug('[serial][settings][apply]', e);
        alert('Ошибка: не удалось сохранить настройки');
      }
      return;
    }
    try{ await send('set_getconfig\n'); }catch(e){ console.debug('[serial][settings][getconfig]', e); }
    toSettingsView();
  });

  // Экспорт и инициализация
  window.sendToSerial     = send;
  window.connectSerial    = connect;
  window.disconnectSerial = disconnect;
  window.openSerialModal  = () => modal.classList.add('show');

  function removeBackToTerminalButton() {
    const byId = document.getElementById('backToTerminalBtn');
    if (byId && byId.parentNode) { byId.parentNode.removeChild(byId); return; }
    const btns = modal.querySelectorAll('button, a');
    for (const b of btns) {
      const t = (b.textContent || '').trim().toLowerCase();
      if (t === 'назад к терминалу') {
        try { b.remove(); } catch(e){ console.debug('[serial][rmBackBtn]', e); }
        break;
      }
    }
  }

  function initUI(){
    toTerminalView();
    removeBackToTerminalButton();
    updateActionsUI();
    log("Программа дистанционного управления запущена.");
  }
  initUI();

  if ('serial' in navigator){
    navigator.serial.addEventListener('disconnect', async ()=>{
      if (port || isConnected) await disconnect();
    });
  }
  window.addEventListener('serial-connection-change', updateActionsUI);
  window.addEventListener('beforeunload', ()=>{
    if (isConnected){
      try{ navigator.serial && port && port.close(); }catch(e){ console.debug('[serial][beforeunload]', e); }
    }
  });
})();
