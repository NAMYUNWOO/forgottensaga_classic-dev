/* virtual_keyboard.js — 자체 가상 키보드 + 한글 자모 조합
 *
 * OS 가상 키보드 의존 X — 우리가 직접 키 UI 그리고, 사용자 클릭 시 자모 조합 후 게임에
 * forward. love.js Davidobot fork 의 emscripten ccall/SDL2 textinput export 가 없어
 * Android Chrome 호환 fix 가 불가능 → 자체 UI 로 우회.
 *
 * 한글 조합: love2d_fosa/systems/hangul_input.lua 의 두벌식 호환 자모 조합 알고리즘을
 * JavaScript 으로 직역 (compose / decompose / append_char + COMPOUND_V/COMPOUND_T/SPLIT_T 등).
 *
 * Forward path: forwardChar(ch) → broad InputEvent dispatch (canvas/document/window).
 * Android 호환은 Module 의 가능한 export 확인 후 별도 fix.
 */
const VirtualKeyboard = (() => {
  // ─── 한글 자모 조합 (hangul_input.lua 포팅) ─────────────────────────────────
  const S_BASE = 0xAC00;
  const V_COUNT = 21;
  const T_COUNT = 28;

  const L_BY_COMPAT = {
    0x3131:0, 0x3132:1, 0x3134:2, 0x3137:3, 0x3138:4,
    0x3139:5, 0x3141:6, 0x3142:7, 0x3143:8, 0x3145:9,
    0x3146:10,0x3147:11,0x3148:12,0x3149:13,0x314A:14,
    0x314B:15,0x314C:16,0x314D:17,0x314E:18,
  };
  const V_BY_COMPAT = {
    0x314F:0, 0x3150:1, 0x3151:2, 0x3152:3, 0x3153:4,
    0x3154:5, 0x3155:6, 0x3156:7, 0x3157:8, 0x3158:9,
    0x3159:10,0x315A:11,0x315B:12,0x315C:13,0x315D:14,
    0x315E:15,0x315F:16,0x3160:17,0x3161:18,0x3162:19,
    0x3163:20,
  };
  const T_BY_L = {
    0:1, 1:2, 2:4, 3:7, 5:8, 6:16,
    7:17, 9:19, 10:20, 11:21, 12:22, 14:23,
    15:24, 16:25, 17:26, 18:27,
  };
  const COMPOUND_V = {
    8: {0:9, 1:10, 20:11},
    13:{4:14, 5:15, 20:16},
    18:{20:19},
  };
  const COMPOUND_T = {
    1:{9:3},
    4:{12:5, 18:6},
    8:{0:9, 6:10, 7:11, 9:12, 16:13, 17:14, 18:15},
    17:{9:18},
  };
  const SPLIT_T = {
    3: {left:1, right_l:9},
    5: {left:4, right_l:12},
    6: {left:4, right_l:18},
    9: {left:8, right_l:0},
    10:{left:8, right_l:6},
    11:{left:8, right_l:7},
    12:{left:8, right_l:9},
    13:{left:8, right_l:16},
    14:{left:8, right_l:17},
    15:{left:8, right_l:18},
    18:{left:17,right_l:9},
  };
  const L_BY_T = {};
  Object.keys(T_BY_L).forEach(l => { L_BY_T[T_BY_L[l]] = parseInt(l); });

  function compose(l, v, t) {
    return String.fromCodePoint(S_BASE + ((l * V_COUNT + v) * T_COUNT + (t || 0)));
  }
  function decompose(cp) {
    if (cp == null || cp < S_BASE || cp > 0xD7A3) return null;
    const n = cp - S_BASE;
    return {
      l: Math.floor(n / (V_COUNT * T_COUNT)),
      v: Math.floor((n % (V_COUNT * T_COUNT)) / T_COUNT),
      t: n % T_COUNT,
    };
  }
  function lastChar(s) {
    if (!s || s.length === 0) return { ch:null, cp:null, prefix:'' };
    const arr = Array.from(s);  // code-point 단위
    const ch = arr[arr.length - 1];
    return { ch: ch, cp: ch.codePointAt(0), prefix: arr.slice(0, -1).join('') };
  }

  // buffer 끝에 cp (code-point) 한 글자 append 후 조합 결과 return.
  function appendCp(buffer, cp) {
    const ch = String.fromCodePoint(cp);
    const v_new = V_BY_COMPAT[cp];
    if (v_new !== undefined) {
      const { cp: last_cp, prefix } = lastChar(buffer);
      const l_prev = L_BY_COMPAT[last_cp];
      if (l_prev !== undefined) {
        return prefix + compose(l_prev, v_new, 0);
      }
      const dec = decompose(last_cp);
      if (dec) {
        if (dec.t === 0) {
          const cv = COMPOUND_V[dec.v] && COMPOUND_V[dec.v][v_new];
          if (cv !== undefined) return prefix + compose(dec.l, cv, 0);
        } else {
          const sp = SPLIT_T[dec.t];
          if (sp) return prefix + compose(dec.l, dec.v, sp.left)
                              + compose(sp.right_l, v_new, 0);
          const next_l = L_BY_T[dec.t];
          if (next_l !== undefined) return prefix + compose(dec.l, dec.v, 0)
                                                + compose(next_l, v_new, 0);
        }
      }
      return buffer + ch;
    }
    const l_new = L_BY_COMPAT[cp];
    if (l_new !== undefined) {
      const { cp: last_cp, prefix } = lastChar(buffer);
      const dec = decompose(last_cp);
      if (dec) {
        if (dec.t === 0) {
          const final = T_BY_L[l_new];
          if (final !== undefined) return prefix + compose(dec.l, dec.v, final);
        } else {
          const final = COMPOUND_T[dec.t] && COMPOUND_T[dec.t][l_new];
          if (final !== undefined) return prefix + compose(dec.l, dec.v, final);
        }
      }
    }
    return buffer + ch;
  }

  // ─── 키보드 레이아웃 ──────────────────────────────────────────────────────
  const KOREAN_KEYS = {
    normal: [
      ['ㅂ','ㅈ','ㄷ','ㄱ','ㅅ','ㅛ','ㅕ','ㅑ','ㅐ','ㅔ'],
      ['ㅁ','ㄴ','ㅇ','ㄹ','ㅎ','ㅗ','ㅓ','ㅏ','ㅣ'],
      ['ㅋ','ㅌ','ㅊ','ㅍ','ㅠ','ㅜ','ㅡ'],
    ],
    shift: [
      ['ㅃ','ㅉ','ㄸ','ㄲ','ㅆ','ㅛ','ㅕ','ㅑ','ㅒ','ㅖ'],
      ['ㅁ','ㄴ','ㅇ','ㄹ','ㅎ','ㅗ','ㅓ','ㅏ','ㅣ'],
      ['ㅋ','ㅌ','ㅊ','ㅍ','ㅠ','ㅜ','ㅡ'],
    ],
  };
  const ENGLISH_KEYS = {
    normal: [
      ['q','w','e','r','t','y','u','i','o','p'],
      ['a','s','d','f','g','h','j','k','l'],
      ['z','x','c','v','b','n','m'],
    ],
    shift: [
      ['Q','W','E','R','T','Y','U','I','O','P'],
      ['A','S','D','F','G','H','J','K','L'],
      ['Z','X','C','V','B','N','M'],
    ],
  };

  // ─── State ─────────────────────────────────────────────────────────────────
  let _mode = 'ko';      // 'ko' / 'en'
  let _shift = false;
  let _buffer = '';      // 자모 조합 누적 buffer (echo 표시 + 다음 입력 조합 기준)
  let _kbEl = null;      // 키보드 root element
  let _echoEl = null;    // 사용자 입력 echo display

  function getKeys() {
    const ks = _mode === 'ko' ? KOREAN_KEYS : ENGLISH_KEYS;
    return _shift ? ks.shift : ks.normal;
  }

  // ─── forward to game ──────────────────────────────────────────────────────
  // 게임에 글자 1 개 전달. love.js Davidobot fork 의 textinput 라우팅 환경 의존.
  function forwardChar(ch) {
    if (!ch) return;
    // canvas / document / window 모두 dispatch — broad coverage
    const canvas = document.getElementById('canvas');
    const targets = [canvas, document, window].filter(Boolean);
    try {
      const ev = new InputEvent('textinput', { data: ch, bubbles: true, cancelable: true });
      for (const t of targets) { try { t.dispatchEvent(ev); } catch (e) {} }
    } catch (e) {}
    // 추가 시도 — compositionend 도 일부 SDL2 fork 가 처리
    try {
      const cev = new CompositionEvent('compositionend', { data: ch, bubbles: true });
      for (const t of targets) { try { t.dispatchEvent(cev); } catch (e) {} }
    } catch (e) {}
  }
  function forwardKey(keyName) {
    const KEY_MAP = {
      backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      enter:     { key: 'Enter',     code: 'Enter',     keyCode: 13 },
      space:     { key: ' ',         code: 'Space',     keyCode: 32 },
    };
    const def = KEY_MAP[keyName];
    if (!def) return;
    const canvas = document.getElementById('canvas');
    const targets = [canvas, document, window].filter(Boolean);
    for (const type of ['keydown', 'keyup']) {
      const ev = new KeyboardEvent(type, {
        key: def.key, code: def.code, keyCode: def.keyCode, which: def.keyCode,
        bubbles: true, cancelable: true,
      });
      for (const t of targets) { try { t.dispatchEvent(ev); } catch (e) {} }
    }
  }

  // ─── 키 입력 처리 ─────────────────────────────────────────────────────────
  function handleChar(ch) {
    // 한글 자모면 조합 진행. 영문/숫자 면 buffer 에 단순 append + 직접 forward.
    if (_mode === 'ko') {
      const cp = ch.codePointAt(0);
      const before = _buffer;
      const after = appendCp(_buffer, cp);
      _buffer = after;
      // game forward: before 와 after 의 마지막 글자가 다르면 — 마지막 글자 한 번 forward.
      // 단순화: 전체 buffer 의 마지막 글자 1 개 만 매번 forward — 게임 prompt 가 append 하는
      // 동작 가정. 단 — 한글 조합은 이전 글자를 변경 (예 ㄱ → 가). 게임 prompt 가 append-only
      // 면 변경 처리 불가능. 따라서 — backspace + 다시 append 으로 시뮬레이션.
      const beforeArr = Array.from(before);
      const afterArr = Array.from(after);
      const commonLen = Math.min(beforeArr.length, afterArr.length);
      let divergeAt = commonLen;
      for (let i = 0; i < commonLen; i++) {
        if (beforeArr[i] !== afterArr[i]) { divergeAt = i; break; }
      }
      // before 의 divergeAt 이후 char 만큼 backspace 보냄
      const toErase = beforeArr.length - divergeAt;
      for (let i = 0; i < toErase; i++) forwardKey('backspace');
      // after 의 divergeAt 이후 char forward
      for (let i = divergeAt; i < afterArr.length; i++) {
        forwardChar(afterArr[i]);
      }
    } else {
      _buffer += ch;
      forwardChar(ch);
    }
    if (_shift && _mode === 'en') _shift = false;  // 영문 shift 는 1 글자 후 해제
    render();
  }
  function handleSpecial(action) {
    if (action === 'shift') {
      _shift = !_shift;
      render();
    } else if (action === 'lang') {
      _mode = _mode === 'ko' ? 'en' : 'ko';
      _shift = false;
      _buffer = '';  // 모드 전환 시 조합 buffer reset (다음 자모 조합 기준 새로)
      render();
    } else if (action === 'backspace') {
      if (_buffer.length > 0) {
        _buffer = _buffer.slice(0, -1);
      }
      forwardKey('backspace');
      render();
    } else if (action === 'space') {
      _buffer = '';  // 띄어쓰기는 조합 buffer reset
      forwardKey('space');
      render();
    } else if (action === 'enter') {
      _buffer = '';
      forwardKey('enter');
      render();
    } else if (action === 'close') {
      VirtualKeyboard.hide();
    }
  }

  // 버튼에 robust press handler 등록 — touchstart 에서 직접 처리 (preventDefault 후
  // iOS Safari 가 click event 안 발생시키는 버그 회피). pointerdown 도 등록 (Android
  // / PC mouse 호환). 중복 trigger 방지 flag.
  function bindPress(el, fn) {
    let consumed = false;
    const press = (e) => {
      if (consumed) return;
      consumed = true;
      setTimeout(() => { consumed = false; }, 80);  // touchend 후 ghost mouse 무시
      try { e.preventDefault(); } catch (_) {}
      try { e.stopPropagation(); } catch (_) {}
      fn();
    };
    el.addEventListener('touchstart', press, { passive: false });
    el.addEventListener('mousedown', press);
    // pointerdown 도 등록 (modern browsers + pen + multi-touch 호환)
    el.addEventListener('pointerdown', press);
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  function render() {
    if (!_kbEl) return;
    // 키 영역만 새로 그림 (toolbar / echo 는 그대로)
    const keysContainer = _kbEl.querySelector('.vk-keys');
    keysContainer.innerHTML = '';
    const rows = getKeys();
    for (const row of rows) {
      const r = document.createElement('div');
      r.className = 'vk-row';
      for (const ch of row) {
        const b = document.createElement('button');
        b.className = 'vk-key';
        b.textContent = ch;
        bindPress(b, () => handleChar(ch));
        r.appendChild(b);
      }
      keysContainer.appendChild(r);
    }
    // toolbar 의 mode/shift visual update
    const langBtn = _kbEl.querySelector('[data-act="lang"]');
    if (langBtn) langBtn.textContent = _mode === 'ko' ? '한/영' : 'KO/EN';
    const shiftBtn = _kbEl.querySelector('[data-act="shift"]');
    if (shiftBtn) shiftBtn.classList.toggle('active', _shift);
    if (_echoEl) _echoEl.textContent = _buffer || '';
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  function install() {
    if (_kbEl) return;
    _kbEl = document.createElement('div');
    _kbEl.id = 'virtual-keyboard';
    _kbEl.className = 'vk-hidden';
    _kbEl.innerHTML = `
      <div class="vk-echo-wrap"><span class="vk-echo"></span></div>
      <div class="vk-keys"></div>
      <div class="vk-bottom-row">
        <button class="vk-special" data-act="lang">한/영</button>
        <button class="vk-special" data-act="shift">⇧</button>
        <button class="vk-special vk-space" data-act="space">스페이스</button>
        <button class="vk-special" data-act="backspace">⌫</button>
        <button class="vk-special" data-act="enter">↵</button>
        <button class="vk-special vk-close" data-act="close">✕</button>
      </div>
    `;
    document.body.appendChild(_kbEl);
    _echoEl = _kbEl.querySelector('.vk-echo');
    _kbEl.querySelectorAll('[data-act]').forEach(btn => {
      bindPress(btn, () => handleSpecial(btn.dataset.act));
    });
    render();
  }
  function show() {
    if (!_kbEl) install();
    _kbEl.classList.remove('vk-hidden');
    _buffer = '';
    render();
  }
  function hide() {
    if (_kbEl) _kbEl.classList.add('vk-hidden');
  }
  function toggle() {
    if (!_kbEl) install();
    if (_kbEl.classList.contains('vk-hidden')) show();
    else hide();
  }
  function isVisible() {
    return _kbEl && !_kbEl.classList.contains('vk-hidden');
  }

  return { install, show, hide, toggle, isVisible };
})();

window.VirtualKeyboard = VirtualKeyboard;
