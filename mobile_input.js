/* 모바일 가상 키패드 + IME — Forgotten Saga (love.js)
 *
 * 동작:
 *   D-pad / Action 버튼 → KeyboardEvent (keydown/keyup) dispatch.
 *     love.js 의 SDL keyboard 처리가 받음 → Lua love.keypressed / isDown 동작.
 *   IME 버튼 → hidden <input> focus → 모바일 가상 키보드 활성화 → 한국어 IME 조합
 *     완성 후 textinput 이벤트로 game canvas 에 forward.
 *
 * 사용:
 *   index.html 에서 mobile_input.css 와 이 파일을 로드 후
 *   window.addEventListener('load', () => MobileInput.install());
 */

const MobileInput = (() => {
  // SDL/love2d key mapping (love.keyboard.isDown 의 key name)
  const KEY_MAP = {
    up:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
    down:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
    left:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    space: { key: ' ',          code: 'Space',      keyCode: 32 },
    enter: { key: 'Enter',      code: 'Enter',      keyCode: 13 },
    esc:   { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  };

  function dispatchKey(target, type, k) {
    const def = KEY_MAP[k]; if (!def) return;
    const ev = new KeyboardEvent(type, {
      key: def.key, code: def.code, keyCode: def.keyCode, which: def.keyCode,
      bubbles: true, cancelable: true,
    });
    // canvas 에 dispatch — bubbles:true 라 ancestor (document, window) 의 listener 도
    // 한 번에 호출. 이전엔 canvas + window 양쪽에 dispatch 했지만 bubble path 와 겹쳐
    // listener 가 두 번 호출되는 race 발생 (title menu cursor 두 칸 이동 등).
    target.dispatchEvent(ev);
  }

  function bindButton(el, keyName) {
    const canvas = document.getElementById('canvas') || window;
    const press = (ev) => {
      ev.preventDefault();
      el.classList.add('pressed');
      dispatchKey(canvas, 'keydown', keyName);
    };
    const release = (ev) => {
      ev.preventDefault();
      el.classList.remove('pressed');
      dispatchKey(canvas, 'keyup', keyName);
    };
    // touch — passive:false 로 preventDefault 가능
    el.addEventListener('touchstart', press, { passive: false });
    el.addEventListener('touchend', release, { passive: false });
    el.addEventListener('touchcancel', release, { passive: false });
    // mouse — 데스크톱 디버그
    el.addEventListener('mousedown', press);
    el.addEventListener('mouseup', release);
    el.addEventListener('mouseleave', release);
  }

  // SDL2 textinput 라우팅 — iOS / Android / BlueStacks 모두 동일 path 로 forward.
  // 1순위 emscripten ccall (Android), 2순위 emscripten hidden input simulate, 3순위
  // canvas InputEvent (iOS). 첫 successful method 캐시.
  // emscripten ccall name 은 underscore 없이 호출 (emscripten 이 _ prefix 자동 추가).
  const FWD_CCALL_CANDIDATES = [
    'SDL_SendKeyboardText',
    'SDL_TextInputEvent',
    'emscripten_text_input',
    'textinput',
  ];
  let _fwdMethod = null;
  let _emscriptenInput = null;
  let _fwdDebugLogged = false;
  // console.log + window.__logPush (설정 모달의 디버그로그 탭에서도 visible)
  function _dbgLog() {
    const args = Array.prototype.slice.call(arguments);
    console.log.apply(console, args);
    if (window.__logPush) {
      try { window.__logPush(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), false); } catch (e) {}
    }
  }
  function findEmscriptenInput() {
    if (_emscriptenInput && document.contains(_emscriptenInput)) return _emscriptenInput;
    const ours = document.getElementById('mobile-ime');
    const all = document.querySelectorAll('input, textarea');
    for (const el of all) {
      if (el === ours) continue;
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      if (r.width < 5 || r.height < 5
          || cs.opacity === '0' || cs.visibility === 'hidden'
          || cs.display === 'none') {
        _emscriptenInput = el;
        return el;
      }
    }
    return null;
  }

  function installIME() {
    const ime = document.getElementById('mobile-ime');
    if (!ime) return;
    // 사용자 시각 확인용 별도 누적 buffer — textbox value 가 환경별로 누적/clear
    // 동작이 달라서 (특히 iOS Safari + 한글 IME) 우리가 직접 buffer 관리 + textbox.value
    // 에 강제 write 하여 사용자 시각에 반드시 보이게.
    let visBuf = '';
    let composing = false;
    ime._resetForwardState = () => { visBuf = ''; ime.value = ''; };

    function forwardChar(ch) {
      if (!ch) return;
      // 디버그 첫 1 회 — Module 의 모든 textinput-related export 확인
      if (!_fwdDebugLogged) {
        _fwdDebugLogged = true;
        const M = window.Module;
        _dbgLog('[fwd] Module:', !!M, 'ccall:', !!(M && M.ccall), 'cwrap:', !!(M && M.cwrap));
        if (M) {
          // Module 의 모든 key 중 textinput / SDL / text 관련 grep
          try {
            const keys = Object.keys(M);
            const related = keys.filter(k => /text|sdl|input|kbd|keyboard|comp/i.test(k));
            _dbgLog('[fwd] Module keys (related, total ' + keys.length + '):', related.slice(0, 30).join(', '));
          } catch (e) { _dbgLog('[fwd] Object.keys err:', e.message); }
          // SDL2 namespace
          if (M.SDL2) {
            try { _dbgLog('[fwd] Module.SDL2 keys:', Object.keys(M.SDL2).join(', ')); } catch (e) {}
          }
        }
      }
      const M = window.Module;
      // 1순위: Module 안 직접 함수 lookup (ccall 없어도 _SDL_xxx 직접 호출 가능 시)
      if (M) {
        for (const name of FWD_CCALL_CANDIDATES) {
          // emscripten 은 보통 _ prefix. M['_SDL_SendKeyboardText'] 직접 접근
          const fn = M['_' + name] || M[name];
          if (typeof fn === 'function') {
            try {
              // C string 으로 호출 — UTF8 encode 필요. M.allocateUTF8 사용
              if (M.allocateUTF8 && M._free) {
                const ptr = M.allocateUTF8(ch);
                fn(ptr);
                M._free(ptr);
              } else {
                fn(ch);  // best effort
              }
              if (!_fwdMethod) {
                _fwdMethod = 'direct:' + name;
                _dbgLog('[fwd] using', _fwdMethod);
              }
              return;
            } catch (e) { /* try next */ }
          }
        }
      }
      // 2순위: ccall 시도 (있으면)
      if (M && M.ccall) {
        for (const name of FWD_CCALL_CANDIDATES) {
          try {
            M.ccall(name, null, ['string'], [ch]);
            if (!_fwdMethod) {
              _fwdMethod = 'ccall:' + name;
              _dbgLog('[fwd] using', _fwdMethod);
            }
            return;
          } catch (e) { /* try next */ }
        }
      }
      // 3순위: 광범위 InputEvent dispatch — canvas, document, window 모두
      const canvas = document.getElementById('canvas') || window;
      const targets = [canvas, document, window];
      const evType = (typeof InputEvent !== 'undefined') ? InputEvent : Event;
      try {
        const ev = new evType('textinput', { data: ch, bubbles: true });
        for (const t of targets) {
          try { t.dispatchEvent(ev); } catch (e) {}
        }
        if (!_fwdMethod) {
          _fwdMethod = 'inputEvent-broad';
          _dbgLog('[fwd] using', _fwdMethod);
        }
      } catch (e) {
        _dbgLog('[fwd] InputEvent fail:', e.message);
      }
    }
    function appendVisible(text) {
      if (!text) return;
      visBuf += text;
      // 너무 길면 끝에서 30 자만 유지 (textbox UX)
      if (visBuf.length > 30) visBuf = visBuf.slice(-30);
      ime.value = visBuf;
    }

    ime.addEventListener('compositionstart', () => { composing = true; });
    ime.addEventListener('compositionend', (ev) => {
      composing = false;
      // 조합 완료 — ev.data 가 최종 한글 (예 "각"). game 으로 forward + textbox 누적.
      const data = ev.data || '';
      for (const ch of data) forwardChar(ch);
      appendVisible(data);
    });
    ime.addEventListener('input', (ev) => {
      // input event 의 inputType 으로 종류 구분.
      const it = ev.inputType || '';
      if (it === 'insertCompositionText' || composing) {
        // 조합 중 — visBuf 는 그대로, 단 textbox 에 조합 중간 결과 보이도록
        // ime.value = visBuf + ev.data 로 set (compositionend 시 final 로 덮어씀).
        ime.value = visBuf + (ev.data || '');
        return;
      }
      if (it.startsWith('delete')) {
        // textbox backspace — visBuf 한 글자 줄임 (시각만, 게임엔 backspace 안 보냄)
        visBuf = visBuf.slice(0, -1);
        ime.value = visBuf;
        return;
      }
      // 일반 영문/숫자 직접 입력 — ev.data 의 char forward + 누적 visible
      const data = ev.data;
      if (!data) return;
      for (const ch of data) forwardChar(ch);
      appendVisible(data);
    });
  }

  // === Joystick — nipplejs 사용 (multi-touch / touchcancel / Pointer Events 검증된 lib) ===
  // hand-rolled touch handler 가 multi-touch / ghost touch / stuck 이슈 발생 → nipplejs 로 교체.
  // dir event 시 4 방향 keydown/keyup dispatch. hold 시 우리 repeat timer 로 OS keyrepeat 흉내.
  function installJoystick() {
    const zone = document.getElementById('joystick');
    if (!zone) return;
    if (typeof nipplejs === 'undefined') {
      console.warn('[MobileInput] nipplejs 미로드 — joystick 비활성');
      return;
    }
    const canvas = document.getElementById('canvas') || window;
    const REPEAT_DELAY    = 400;
    const REPEAT_INTERVAL = 110;

    let curDir = null;
    let repeatTimer = null;
    let repeatInterval = null;

    function clearRepeat() {
      if (repeatTimer)    { clearTimeout(repeatTimer);   repeatTimer = null; }
      if (repeatInterval) { clearInterval(repeatInterval); repeatInterval = null; }
    }
    function startRepeat(dir) {
      clearRepeat();
      repeatTimer = setTimeout(() => {
        repeatInterval = setInterval(() => {
          if (curDir !== dir) { clearRepeat(); return; }
          const def = KEY_MAP[dir]; if (!def) return;
          const ev = new KeyboardEvent('keydown', {
            key: def.key, code: def.code, keyCode: def.keyCode, which: def.keyCode,
            repeat: true, bubbles: true, cancelable: true,
          });
          canvas.dispatchEvent(ev);
        }, REPEAT_INTERVAL);
      }, REPEAT_DELAY);
    }

    function setDir(newDir) {
      if (newDir === curDir) return;
      if (curDir) {
        dispatchKey(canvas, 'keyup', curDir);
        clearRepeat();
      }
      if (newDir) {
        dispatchKey(canvas, 'keydown', newDir);
        startRepeat(newDir);
      }
      curDir = newDir;
    }

    const stick = nipplejs.create({
      zone: zone,
      mode: 'static',
      position: { left: '50%', top: '50%' },
      size: 168,
      threshold: 0.45,        // knob 이 radius 의 45% 이상 이동 시 dir 활성 (jitter 방지)
      color: 'rgba(120, 160, 220, 0.75)',
      fadeTime: 100,
      restJoystick: true,     // touch 떼면 knob 가운데 복원
      restOpacity: 0.5,
    });

    stick.on('dir', (evt, data) => {
      // data.direction.angle: 'up' / 'down' / 'left' / 'right' (KEY_MAP 와 일치)
      const dir = data && data.direction && data.direction.angle;
      if (dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right') {
        setDir(dir);
      }
    });
    stick.on('end', () => { setDir(null); });

    // 페이지 hidden / blur 시 stuck 방지 — 모든 active 키 release
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) setDir(null);
    });
    window.addEventListener('blur', () => setDir(null));
  }

  function install() {
    // 좌하단 조이스틱 (D-pad 대체)
    installJoystick();
    // Action 버튼 (esc / space / enter)
    document.querySelectorAll('#mobile-input .actions .btn').forEach(el => {
      const k = el.dataset.key;
      if (k) bindButton(el, k);
    });
    // 키보드 토글 — 자체 가상 키보드 (window.VirtualKeyboard) 사용.
    // OS 가상 키보드 의존 X → iOS/Android/BlueStacks 환경 무관 일관 동작.
    // 기존 #mobile-ime textbox 는 호환용 hidden — 사용자에게 보이지 않음.
    const imeBtn = document.getElementById('btn-ime');
    if (imeBtn) {
      imeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!window.VirtualKeyboard) {
          console.warn('[MobileInput] VirtualKeyboard 미로드');
          return;
        }
        window.VirtualKeyboard.toggle();
        imeBtn.classList.toggle('active', window.VirtualKeyboard.isVisible());
      });
    }
    installIME();
    console.log('[MobileInput] installed');
  }

  return { install, dispatchKey };
})();

window.MobileInput = MobileInput;
