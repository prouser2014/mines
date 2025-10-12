/** security.js — PIN-защита + автосохранение + полноэкранный вход
 *  • Поля настроек всегда type="text" и выглядят одинаково.
 *  • Маскирование реализовано "мягко": отображаем ****, реальное значение храним в WeakMap.
 *  • Кнопка-«глаз» переключает показ: маска ↔ цифры, тип поля не меняется.
 *  • Автосохранение при совпадении (4–8 цифр), подсветка ошибок, сброс незавершённого ввода при уходе.
 *  • Вход в приложение — полноэкранный Android-стиль; 3 ошибки → очистка БД и сброс PIN.
 *  • PIN хранится как SHA-256(PEPPER+PIN) в localStorage; в общий файл попадает только {enabled, hash}.
 */
(() => {
  'use strict';

  // ===== Ключи localStorage
  const K_ENABLED    = 'SEC_ENABLED';     // '1' | '0'
  const K_HASH       = 'SEC_PIN_HASH';    // hex(SHA-256(PEPPER + pin))
  const K_LOCK_UNTIL = 'SEC_LOCK_UNTIL';  // ms timestamp
  const K_ATTEMPTS   = 'SEC_ATTEMPTS_MAX';

  // ===== Настройки
  const ATTEMPTS_MAX = 3;
  const PEPPER       = 'loctar.v1.pepper';

  // ===== Утилиты
  const $ = (sel, root=document) => root.querySelector(sel);
  const clamp = (v,a,b)=>Math.min(b,Math.max(a,v));
  const hasLS = () => { try { return typeof localStorage!=='undefined' && !!localStorage.setItem; } catch { return false; } };
  const lsGet = (k,d=null)=>{ try{ const v=localStorage.getItem(k); return v==null?d:v; } catch { return d; } };
  const lsSet = (k,v)=>{ try{ localStorage.setItem(k,v);}catch{} };
  const lsDel = (k)=>{ try{ localStorage.removeItem(k);}catch{} };

  async function sha256Hex(text){
    const enc=new TextEncoder();
    const buf=await crypto.subtle.digest('SHA-256', enc.encode(String(text)));
    return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  const hashPin = (pin)=>sha256Hex(PEPPER + String(pin));

  const normalizePin = raw => String(raw??'').replace(/[^0-9]/g,'').slice(0,8);
  const isPinValid   = pin => pin.length>=4 && pin.length<=8;

  // ====== "Мягкая" маска для инпутов PIN (всегда type="text")
  const realMap = new WeakMap(); // input -> "1234"
  const getReal = (inp)=> realMap.get(inp) || '';
  const setReal = (inp, val)=> { realMap.set(inp, normalizePin(val)); renderMasked(inp); };
  const isShown = (inp)=> inp?.dataset.show === '1';
  const setShow = (inp, on)=> { if (!inp) return; inp.dataset.show = on?'1':'0'; renderMasked(inp); };

  function renderMasked(inp){
    if (!inp) return;
    const v = getReal(inp);
    const show = isShown(inp);
    inp.value = show ? v : (v ? '*'.repeat(v.length) : '');
    // курсор в конец
    try { const p = inp.value.length; inp.setSelectionRange(p,p); } catch {}
  }

  function initSoftPinInput(inp){
    if (!inp) return;
    realMap.set(inp, '');
    inp.dataset.show = '0'; // по умолчанию скрыто
    inp.autocomplete = 'off';
    inp.inputMode = 'numeric';
    inp.pattern = '[0-9]{4,8}';

    // Основная обработка ввода (поддержка десктоп/мобайл)
    inp.addEventListener('beforeinput', (e)=>{
      const type = e.inputType;
      if (type === 'insertText') {
        const ch = String(e.data||'');
        if (/^[0-9]$/.test(ch) && getReal(inp).length<8){
          setReal(inp, getReal(inp) + ch);
        }
        e.preventDefault();
      } else if (type === 'deleteContentBackward' || type === 'deleteContentForward') {
        const v = getReal(inp);
        if (v.length) setReal(inp, v.slice(0,-1));
        e.preventDefault();
      } else if (type === 'insertFromPaste') {
        const data = (e.dataTransfer?.getData('text') ?? e.target.ownerDocument?.defaultView?.navigator.clipboardData?.getData('text') ?? '');
        const add = normalizePin(data);
        if (add) setReal(inp, (getReal(inp) + add).slice(0,8));
        e.preventDefault();
      } else {
        // блокируем любые другие типы (перетаскивание, иероглифы и т.п.)
        e.preventDefault();
      }
    });

    // Фолбэк для старых движков без beforeinput
    inp.addEventListener('keydown', (e)=>{
      if (/^[0-9]$/.test(e.key) && getReal(inp).length<8) {
        setReal(inp, getReal(inp)+e.key);
        e.preventDefault();
      } else if (e.key==='Backspace' || e.key==='Delete'){
        const v=getReal(inp); if(v) setReal(inp, v.slice(0,-1));
        e.preventDefault();
      } else if (e.key==='Tab' || e.key==='ArrowLeft' || e.key==='ArrowRight') {
        // позволяем навигацию по форме
      } else {
        e.preventDefault();
      }
    });

    // На всякий случай не даём браузеру самовольно менять значение
    inp.addEventListener('input', (e)=> { renderMasked(inp); e.preventDefault(); });

    renderMasked(inp);
  }

  // ===== Интеграция с общим файлом данных
  window.getSecuritySnapshot = function(){
    try{
      const enabled = lsGet(K_ENABLED,'0')==='1';
      const hash    = lsGet(K_HASH,'')||null;
      if (!hash) return {enabled:false, hash:null, v:1};
      return {enabled, hash, v:1};
    }catch{ return {enabled:false, hash:null, v:1}; }
  };
  window.applySecurityFromSnapshot = function(sec){
    if (!sec || !hasLS()) return;
    try{
      if (sec.hash) lsSet(K_HASH,String(sec.hash)); else lsDel(K_HASH);
      if (typeof sec.enabled==='boolean') lsSet(K_ENABLED, sec.enabled?'1':'0'); else lsSet(K_ENABLED,'0');
      lsSet(K_ATTEMPTS, String(ATTEMPTS_MAX));
      lsDel(K_LOCK_UNTIL);
    }catch{}
  };
  window.addEventListener('fs:dbLoaded', (ev)=>{
    try{ window.applySecurityFromSnapshot?.(ev.detail?.db?.security); }catch{}
  });

  // ===== Стили для настроек
  function ensureSettingsStyles(){
    if (document.getElementById('securitySettingsStyles')) return;
    const css=document.createElement('style');
    css.id='securitySettingsStyles';
    css.textContent = `
      .sec-input.error{
        border-color: var(--c-danger) !important;
        box-shadow: 0 0 0 0.125rem color-mix(in srgb, var(--c-danger) 20%, transparent);
        background-color: var(--c-danger-light-bg);
        color: var(--c-danger-light-text);
      }
      .sec-hint{ font-size:.9em; color: var(--c-text-secondary); }
      .sec-hint.success{ color: var(--c-success); }
      .sec-hint.error{ color: var(--c-danger); }

      .pin-input-wrap{ position: relative; display:block; }
      .pin-input-wrap .sec-input{ width:100%; padding-right:2.25rem; }

      .pin-eye{
        position:absolute; right:.35rem; top:50%; transform:translateY(-50%);
        width:1.6rem; height:1.6rem; border:none; background:transparent; padding:0;
        display:inline-flex; align-items:center; justify-content:center;
        cursor:pointer; opacity:.75; z-index:2;
      }
      .pin-eye:hover{ opacity:1; }
      .pin-eye img{ width:1.2rem; height:1.2rem; pointer-events:none; }
      .pin-eye.on{ opacity:1; }
    `;
    document.head.appendChild(css);
  }

  // ===== UI «Безопасность»
  function buildSecuritySettingsUI(){
    ensureSettingsStyles();
    const host = $('#securitySettingsHost');
    if (!host) return;

    const enabled = lsGet(K_ENABLED,'0')==='1';
    const hasPin  = !!lsGet(K_HASH,'');
    const lsOk    = hasLS();

    host.innerHTML = `
      <label class="checkbox-row">
        <input type="checkbox" id="secEnabled"${enabled&&hasPin&&lsOk?' checked':''} ${!lsOk?' disabled':''}>
        <span>Включить защиту входа PIN-кодом</span>
      </label>

      <div class="form-grid-compact" style="margin-top:.5rem;">
        <label for="secNewPin">Новый PIN (4–8 цифр):</label>
        <div class="pin-input-wrap">
          <input id="secNewPin" class="sec-input" type="text" inputmode="numeric" maxlength="8" autocomplete="off" ${!lsOk?' disabled':''}>
          <button class="pin-eye" type="button" data-target="secNewPin" aria-label="Показать PIN">
            <img src="icons/eye.svg" alt="">
          </button>
        </div>

        <label for="secNewPin2">Повторите PIN:</label>
        <div class="pin-input-wrap">
          <input id="secNewPin2" class="sec-input" type="text" inputmode="numeric" maxlength="8" autocomplete="off" ${!lsOk?' disabled':''}>
          <button class="pin-eye" type="button" data-target="secNewPin2" aria-label="Показать PIN">
            <img src="icons/eye.svg" alt="">
          </button>
        </div>
      </div>

      <div class="sec-hint" id="secHint">
        ${!lsOk ? 'Внимание: localStorage отключён — сохранить PIN невозможно.' : 'PIN сохраняется автоматически при совпадении двух полей.'}
      </div>
    `;

    const chk  = $('#secEnabled');
    const in1  = $('#secNewPin');
    const in2  = $('#secNewPin2');
    const hint = $('#secHint');

    // инициализируем «мягкую» маску
    initSoftPinInput(in1);
    initSoftPinInput(in2);

    // «Глаз» — только переключение режима показа, тип поля не меняем
    function bindEye(btn){
      const id = btn.dataset.target;
      const inp = document.getElementById(id);
      btn.addEventListener('click', ()=>{
        const on = !isShown(inp);
        setShow(inp, on);
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-label', on?'Скрыть PIN':'Показать PIN');
      });
    }
    host.querySelectorAll('.pin-eye').forEach(bindEye);

    // Автосохранение/подсветка
    async function updateState(){
      if (!lsOk) return;
      const p1 = getReal(in1);
      const p2 = getReal(in2);

      const mismatch = (p1.length>0 || p2.length>0) && (p1!==p2 || !isPinValid(p1));
      in2?.classList.toggle('error', mismatch);

      if (mismatch) {
        if (hint){ hint.textContent='PIN не совпадает или длина не 4–8 цифр.'; hint.className='sec-hint error'; }
        return;
      }

      if (p1.length===0 && p2.length===0){
        in2?.classList.remove('error');
        if (hint){ hint.textContent='PIN сохраняется автоматически при совпадении двух полей.'; hint.className='sec-hint'; }
        return;
      }

      if (isPinValid(p1) && p1===p2){
        const hash = await hashPin(p1);
        lsSet(K_HASH, hash);
        lsSet(K_ENABLED, '1');
        lsSet(K_ATTEMPTS, String(ATTEMPTS_MAX));
        in2?.classList.remove('error');
        if (chk) chk.checked = true;

        // После сохранения значения остаются; принудительно скрываем показ
        setShow(in1, false);
        setShow(in2, false);
        host.querySelectorAll('.pin-eye').forEach(btn=>{
          btn.classList.remove('on');
          btn.setAttribute('aria-label','Показать PIN');
        });

        if (hint){ hint.textContent='PIN сохранён. Защита включена.'; hint.className='sec-hint success'; }
        try { window.saveDataToFileNow?.(); } catch {}
      }
    }

    // триггеры
    ['beforeinput','keydown','input'].forEach(ev=>{
      in1.addEventListener(ev, ()=> setTimeout(updateState,0));
      in2.addEventListener(ev, ()=> setTimeout(updateState,0));
    });

    // Сброс незавершённого PIN при уходе/переключении вкладок (если не совпал)
    const resetIfDirtyMismatch = ()=>{
      const p1=getReal(in1), p2=getReal(in2);
      const mismatch = (p1.length>0 || p2.length>0) && (p1!==p2 || !isPinValid(p1));
      if (mismatch){
        setReal(in1,''); setReal(in2,'');
        in2?.classList.remove('error');
        setShow(in1,false); setShow(in2,false);
        host.querySelectorAll('.pin-eye').forEach(btn=>{
          btn.classList.remove('on');
          btn.setAttribute('aria-label','Показать PIN');
        });
        if (hint){ hint.textContent='Несовпавший PIN был сброшен.'; hint.className='sec-hint'; }
      }
    };
    document.addEventListener('click', (e)=>{
      const btn=e.target.closest?.('.as-menu-btn');
      if (btn && btn.dataset.pane!=='paneSecurity') resetIfDirtyMismatch();
      const closeBtn = e.target.closest?.('.modal .close');
      if (closeBtn) resetIfDirtyMismatch();
    });
    document.addEventListener('visibilitychange', ()=>{ if (document.hidden) resetIfDirtyMismatch(); });

    // Включение/выключение защиты
    chk?.addEventListener('change', ()=>{
      const on = !!chk.checked;
      if (on && !lsGet(K_HASH)) {
        alert('Сначала задайте PIN: введите его в оба поля одинаково (4–8 цифр).');
        chk.checked=false; return;
      }
      lsSet(K_ENABLED, on?'1':'0');
      try { window.saveDataToFileNow?.(); } catch {}
    });
  }

  // ===== Сброс защиты/БД
  function clearSecurity(){
    try{
      lsDel(K_HASH); lsSet(K_ENABLED,'0'); lsDel(K_LOCK_UNTIL); lsSet(K_ATTEMPTS,String(ATTEMPTS_MAX));
    }catch{}
  }

  async function destructiveWipeAllData(){
    try{
      try { if (Array.isArray(window.nodesManager?.nodes)) { window.nodesManager.nodes.length=0; window.nodesManager._saveToStorage?.(); try{ updateNodeList?.(); }catch{} } } catch {}
      try { if (Array.isArray(window.minesManager?.mines)) { window.minesManager.mines.length=0; window.minesManager._saveToStorage?.(); try{ updateMineList?.(); }catch{} } } catch {}
      try { localStorage.removeItem(typeof LS_KEY_NODES!=='undefined'?LS_KEY_NODES:'RFNodes.v1.nodes'); } catch {}
      try { localStorage.removeItem(typeof LS_KEY_MINES!=='undefined'?LS_KEY_MINES:'RFMines.v1.mines'); } catch {}
      clearSecurity();
      try { await window.saveDataToFileNow?.(); } catch {}
      console.warn('[security] База данных и PIN уничтожены после 3 неверных попыток.');
      if (navigator.vibrate) try { navigator.vibrate([120,80,120]); } catch {}
    }catch(e){ console.error('destructiveWipeAllData failed', e); }
  }

  // ===== Полноэкранный ввод PIN (оставил как было)
  let overlayEl=null, pinInput=null, msgEl=null, okBtn=null, prevHtmlOverflow='';
  function ensureOverlayStyles(){
    if (document.getElementById('securityStyles')) return;
    const css=document.createElement('style'); css.id='securityStyles';
    css.textContent=`
      .security-overlay{position:fixed; inset:0; z-index:2147483600; width:100vw; height:100dvh;
        display:grid; grid-template-rows:1fr auto; background:#0b1320; color:#fff;
        padding:2.5vh 6vw calc(2.5vh + env(safe-area-inset-bottom,0px)) 6vw; box-sizing:border-box;}
      .security-top{display:flex; flex-direction:column; align-items:center; justify-content:stretch; min-height:0; gap:.7rem; text-align:center; padding-bottom:.5rem;}
      .brand-wrap{flex:1 1 auto; min-height:0; width:100%; display:flex; align-items:center; justify-content:center;}
      .brand-wrap img{max-width:100%; max-height:100%; width:auto; height:auto; object-fit:contain;}
      .security-title{font-size:1.05rem; opacity:.92; margin-top:.1rem;}
      .pin-dots{display:flex; gap:.8rem; min-height:1.4rem; margin-bottom:.6rem;}
      .pin-dot{width:.9rem; height:.9rem; border-radius:50%; background:#fff;}
      .security-msg{min-height:1.2em; font-size:.95rem; color:rgba(255,255,255,.75);}
      .keypad{width:100%; max-width:520px; margin:0 auto; display:grid; grid-template-columns:repeat(3,1fr); gap:.9rem; padding-bottom:.3rem; user-select:none; -webkit-user-select:none;}
      .kbtn{height:clamp(56px,9.5vh,86px); border-radius:999px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.18); color:#fff; cursor:pointer;
        display:flex; flex-direction:column; align-items:center; justify-content:center; font-weight:700; transition:transform .06s ease, background .12s ease;}
      .kbtn:active{transform:scale(.98); background:rgba(255,255,255,.12);}
      .kbtn .sub{font-size:.7rem; font-weight:500; opacity:.65; margin-top:.08rem;}
      .kbtn.back{font-size:1.25rem;}
      .kbtn.ok{background:#2b78e4; border:none;}
      .kbtn.ok[disabled]{opacity:.45; cursor:default; background:rgba(255,255,255,.18);}
      @media (max-width:380px){ .security-overlay{padding-left:4vw; padding-right:4vw;} .pin-dot{width:.8rem; height:.8rem;} }
    `;
    document.head.appendChild(css);
  }
  function buildOverlay(){
    ensureOverlayStyles();
    overlayEl=document.createElement('div');
    overlayEl.className='security-overlay'; overlayEl.setAttribute('role','dialog'); overlayEl.setAttribute('aria-modal','true');
    overlayEl.innerHTML=`
      <div class="security-top">
        <div class="brand-wrap"><img src="img/main.png" alt=""></div>
        <input id="secPinInput" type="password" autocomplete="off" inputmode="none" style="position:absolute;opacity:0;width:0;height:0;border:0;padding:0">
        <div class="security-title">Введите PIN</div>
        <div class="pin-dots" id="pinDots"></div>
        <div class="security-msg" id="secMsg"></div>
      </div>
      <div class="keypad" id="pinPad" aria-hidden="false"></div>
    `;
    document.body.appendChild(overlayEl);
    prevHtmlOverflow=document.documentElement.style.overflow; document.documentElement.style.overflow='hidden';

    pinInput=$('#secPinInput'); msgEl=$('#secMsg');
    const dots=$('#pinDots'); const pad=$('#pinPad');

    const MAXLEN=8, MINLEN=4;
    const renderDots=(n)=>{ dots.innerHTML=''; for(let i=0;i<Math.max(0,Math.min(MAXLEN,n));i++){ const d=document.createElement('div'); d.className='pin-dot'; dots.appendChild(d);} };

    renderDots(0);
    const keys=[{d:'1'},{d:'2',sub:'ABC'},{d:'3',sub:'DEF'},{d:'4',sub:'GHI'},{d:'5',sub:'JKL'},{d:'6',sub:'MNO'},{d:'7',sub:'PQRS'},{d:'8',sub:'TUV'},{d:'9',sub:'WXYZ'},{ok:true},{d:'0'},{back:true}];
    pad.innerHTML=keys.map(k=>{
      if(k.d) return `<button class="kbtn" data-k="${k.d}" type="button"><div>${k.d}</div>${k.sub?`<div class="sub">${k.sub}</div>`:''}</button>`;
      if(k.back) return `<button class="kbtn back" data-back="1" type="button" aria-label="Стереть">←</button>`;
      if(k.ok) return `<button class="kbtn ok" id="secEnterBtn" type="button" disabled aria-label="ОК">✓</button>`;
      return '';
    }).join('');
    const okBtn = $('#secEnterBtn');

    const updateUI=()=>{ const val=normalizePin(pinInput.value); pinInput.value=val; renderDots(val.length); okBtn.disabled = !(val.length>=MINLEN && lockoutLeftMs()<=0); };

    pad.querySelectorAll('.kbtn[data-k]').forEach(b=> b.addEventListener('click',()=>{ pinInput.value = normalizePin(pinInput.value + b.dataset.k); updateUI(); }) );
    const backBtn=pad.querySelector('.kbtn[data-back]');
    if(backBtn){
      let t=null,long=false; const start=()=>{ long=false; t=setTimeout(()=>{ long=true; pinInput.value=''; updateUI(); },500); };
      const end=()=>{ if(!t) return; clearTimeout(t); t=null; if(!long){ const v=pinInput.value; if(v){ pinInput.value=v.slice(0,-1); updateUI(); } } };
      backBtn.addEventListener('mousedown',start); backBtn.addEventListener('mouseup',end); backBtn.addEventListener('mouseleave',()=>{ if(t){clearTimeout(t); t=null;}});
      backBtn.addEventListener('touchstart',start,{passive:true}); backBtn.addEventListener('touchend',end);
    }
    okBtn?.addEventListener('click', tryEnter);

    overlayEl.addEventListener('keydown',(e)=>{
      const w=lockoutLeftMs(); if(w>0) return;
      if(/^[0-9]$/.test(e.key)){ pinInput.value=normalizePin(pinInput.value+e.key); updateUI(); }
      else if(e.key==='Backspace'){ pinInput.value=pinInput.value.slice(0,-1); updateUI(); }
      else if(e.key==='Enter'){ if(!okBtn?.disabled) tryEnter(); }
    });

    const lockoutLeftMs=()=> { const until=Number(lsGet(K_LOCK_UNTIL,0))||0; return Math.max(0, until - Date.now()); };
    function setLockout(ms){ lsSet(K_LOCK_UNTIL, String(Date.now()+ms)); }

    async function tryEnter(){
      const pin = normalizePin(pinInput.value);
      if (!isPinValid(pin)) { msgEl.textContent='Введите 4–8 цифр.'; return; }
      const ok = (await hashPin(pin)) === lsGet(K_HASH,'');

      let attempts = Number(lsGet(K_ATTEMPTS, ATTEMPTS_MAX)) || ATTEMPTS_MAX;
      if (ok){
        lsSet(K_ATTEMPTS, String(ATTEMPTS_MAX)); lsDel(K_LOCK_UNTIL);
        destroyOverlay(); return;
      }
      attempts = clamp(attempts-1,0,ATTEMPTS_MAX); lsSet(K_ATTEMPTS,String(attempts));
      if (attempts<=0){
        msgEl.textContent='Неверно. Данные и PIN уничтожены.'; await destructiveWipeAllData(); try{ alert('Данные базы и PIN были уничтожены после 3 неверных попыток.'); }catch{}
        destroyOverlay(); return;
      } else {
        msgEl.textContent=`Неверно. Осталось попыток: ${attempts}.`; try{ navigator.vibrate?.(70); }catch{}
      }
      pinInput.value=''; renderDots(0); okBtn.disabled=true;
    }

    function destroyOverlay(){
      if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
      overlayEl=null; pinInput=null; msgEl=null;
      document.documentElement.style.overflow = prevHtmlOverflow || '';
    }

    updateUI(); overlayEl.tabIndex=-1; setTimeout(()=>overlayEl.focus({preventScroll:true}),30);

    // делаем функции видимыми в замыкании
    window.tryEnter = tryEnter;
    window.lockoutLeftMs = lockoutLeftMs;
    window.destroyOverlay = destroyOverlay;
  }

  function lockActive(){ if(!hasLS()) return false; return (lsGet(K_ENABLED,'0')==='1') && !!lsGet(K_HASH); }
  function lockoutLeftMs(){ const until=Number(lsGet(K_LOCK_UNTIL,0))||0; return Math.max(0, until - Date.now()); }

  function destroyOverlay(){
    const el = document.querySelector('.security-overlay');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    document.documentElement.style.overflow = '';
  }

  // ===== Старт
  function boot(){
    buildSecuritySettingsUI();
    if (lockActive()){
      if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', buildOverlay, {once:true});
      else buildOverlay();
    }
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot, {once:true});
  else boot();
})();
