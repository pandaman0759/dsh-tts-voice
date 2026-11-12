// @local/dsh-tts-voice — client half.
//
// 1) 播放器：轮询 host 的待播队列，取音频字节用 Blob URL 播放，播完 ack + revoke。
//    音频从不落盘，也从不进 localStorage / IndexedDB。
// 2) 设置页：总开关、总结字数上限、音色 ID、API Key、获取链接。

window.__ModuleLoader__.load({
  id: '@local/dsh-tts-voice',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PREFIX = '/api/dsh-tts-voice'
    const VOICE_LINK = 'https://breezeblue.ai/zh?code=7JXP7Y'
    const POLL_MS = 900

    const css = {
      box: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        fontSize: '13px',
        lineHeight: 1.55,
        color: 'inherit',
        maxWidth: '560px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'space-between' },
      col: { display: 'flex', flexDirection: 'column', gap: '6px' },
      title: { fontWeight: 600, fontSize: '13px' },
      hint: { fontSize: '12px', opacity: 0.62, margin: 0 },
      input: {
        font: 'inherit',
        padding: '6px 9px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.38)',
        background: 'transparent',
        color: 'inherit',
        minWidth: '200px',
      },
      check: { width: '16px', height: '16px', accentColor: 'auto' },
      button: {
        font: 'inherit',
        padding: '6px 12px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.38)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      link: { color: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px' },
      ok: { fontSize: '12px', opacity: 0.8 },
      bad: { fontSize: '12px', color: '#d9534f' },
      divider: { height: '1px', background: 'rgba(127,127,127,0.22)', border: 0, margin: 0 },
      hero: {
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '14px 16px',
        borderRadius: '10px',
        background: 'rgba(127,127,127,0.10)',
        border: '1px solid rgba(127,127,127,0.18)',
      },
      heroNumber: { fontSize: '34px', fontWeight: 700, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' },
      heroUnit: { fontSize: '13px', opacity: 0.7, paddingBottom: '4px' },
      heroMeta: { fontSize: '12px', opacity: 0.66 },
    }

    async function playOnce(blobUrl) {
      const audio = new Audio(blobUrl)
      audio.volume = 1
      audio.preload = 'auto'
      try {
        await new Promise((resolve, reject) => {
          audio.onended = () => resolve()
          audio.onerror = () => reject(new Error('音频播放失败'))
          const started = audio.play()
          if (started && typeof started.then === 'function') started.catch(reject)
        })
      } finally {
        try {
          audio.pause()
        } catch {
          // 忽略：元素可能已经被回收
        }
        audio.src = ''
      }
    }

    // 浏览器在后台标签里偶尔会拒绝第一次 play()（自动播放策略），
    // 换一个全新的 Audio 实例再试一次，比直接丢掉这一条更划算。
    async function playBlob(blobUrl) {
      try {
        await playOnce(blobUrl)
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 350))
        await playOnce(blobUrl)
      }
    }

    function startPlayer(ctx) {
      let stopped = false
      let busy = false
      let timer = null
      const seen = new Set()

      const schedule = (delay) => {
        if (stopped) return
        if (timer) window.clearTimeout(timer)
        timer = window.setTimeout(tick, delay)
      }

      // 页面切到后台也要继续取队列：以前 hidden 直接跳过，结果人一离开窗口
      // 音频就堆在内存里等到过期（120 秒），回来时早就没了——「调用了但没声音」。
      const pollDelay = () =>
        typeof document !== 'undefined' && document.visibilityState === 'hidden'
          ? Math.max(POLL_MS, 2500)
          : POLL_MS

      const tick = async () => {
        if (stopped) return
        if (busy) {
          schedule(pollDelay())
          return
        }
        busy = true
        try {
          const response = await fetch(`${PREFIX}/next`, { headers: { accept: 'application/json' } })
          if (response.ok) {
            const data = await response.json()
            const pending = data && data.pending
            if (pending && pending.id && !seen.has(pending.id)) {
              seen.add(pending.id)
              const audioResponse = await fetch(`${PREFIX}/audio?id=${encodeURIComponent(pending.id)}`)
              if (!audioResponse.ok) {
                const detail = await audioResponse.json().catch(() => ({}))
                console.warn('[dsh-tts-voice] 合成失败', detail && detail.error)
                await fetch(`${PREFIX}/ack`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    id: pending.id,
                    outcome: 'synth-failed',
                    note: (detail && detail.error) || `HTTP ${audioResponse.status}`,
                  }),
                }).catch(() => {})
              } else {
                const blob = await audioResponse.blob()
                const url = URL.createObjectURL(blob)
                let playNote = ''
                try {
                  await playBlob(url)
                } catch (error) {
                  playNote = error && error.message ? error.message : '播放失败'
                  console.warn('[dsh-tts-voice] 播放失败', playNote)
                } finally {
                  URL.revokeObjectURL(url)
                }
                await fetch(`${PREFIX}/ack`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ id: pending.id, outcome: playNote ? 'play-failed' : 'played', note: playNote }),
                }).catch(() => {})
              }
            }
          }
        } catch (error) {
          console.warn('[dsh-tts-voice] 轮询失败', error && error.message)
        } finally {
          busy = false
          if (seen.size > 64) seen.clear()
        }
        schedule(pollDelay())
      }

      const onVisibility = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') schedule(120)
      }
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)

      schedule(600)
      return () => {
        stopped = true
        if (timer) window.clearTimeout(timer)
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      }
    }

    function Icon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M4 12h3l3-6v12l-3-6H4z',
          fill: 'currentColor',
          opacity: 0.9,
        }),
        h('path', {
          d: 'M14 9.2a4 4 0 0 1 0 5.6M17 6.6a8 8 0 0 1 0 10.8',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
      )
    }

    function VoiceSettings() {
      const [loaded, setLoaded] = React.useState(false)
      const [enabled, setEnabled] = React.useState(true)
      const [maxChars, setMaxChars] = React.useState('20')
      const [voiceId, setVoiceId] = React.useState('voc_8yud7hz7c9q2')
      const [instructions, setInstructions] = React.useState('语气轻快、俏皮，像跟熟人随口聊天，句子短，句尾自然收住。')
      const [speed, setSpeed] = React.useState('1')
      const [volume, setVolume] = React.useState('0.9')
      const [audioTags, setAudioTags] = React.useState(true)
      const [autoCheckIn, setAutoCheckIn] = React.useState(true)
      const [siteCookieInput, setSiteCookieInput] = React.useState('')
      const [siteCookieState, setSiteCookieState] = React.useState({ configured: false })
      const [creditState, setCreditState] = React.useState({ lastCheckInDate: '', state: null })
      const [credits, setCredits] = React.useState(null)
      const [creditsNote, setCreditsNote] = React.useState('')
      const [keyInput, setKeyInput] = React.useState('')
      const [keyState, setKeyState] = React.useState({ configured: false, masked: '', source: 'none' })
      const [status, setStatus] = React.useState('')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [trying, setTrying] = React.useState(false)
      const [checking, setChecking] = React.useState(false)

      const applyState = React.useCallback((data) => {
        if (!data) return
        setEnabled(data.enabled !== false)
        setMaxChars(String(data.maxChars ?? 20))
        setVoiceId(data.voiceId || 'voc_8yud7hz7c9q2')
        if (typeof data.instructions === 'string') setInstructions(data.instructions)
        setSpeed(String(data.speed ?? 1))
        setVolume(String(data.volume ?? 0.9))
        setAudioTags(data.audioTags !== false)
        setAutoCheckIn(data.autoCheckIn !== false)
        if (data.siteCookie) setSiteCookieState(data.siteCookie)
        setCreditState((prev) => ({ ...prev, lastCheckInDate: data.lastCheckInDate || '' }))
        setKeyState(data.key || { configured: false, masked: '', source: 'none' })
      }, [])

      React.useEffect(() => {
        let alive = true
        fetch(`${PREFIX}/config`, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (alive) {
              applyState(data)
              setLoaded(true)
            }
          })
          .catch((err) => {
            if (alive) setError(`读取设置失败：${err && err.message ? err.message : err}`)
          })
        return () => {
          alive = false
        }
      }, [applyState])

      const save = React.useCallback(async () => {
        setBusy(true)
        setStatus('')
        setError('')
        try {
          const body = {
            enabled,
            maxChars: Number(maxChars),
            voiceId: voiceId.trim(),
            instructions: instructions.trim(),
            speed: Number(speed),
            volume: Number(volume),
            audioTags,
            autoCheckIn,
          }
          if (keyInput.trim()) body.apiKey = keyInput.trim()
          if (siteCookieInput.trim()) body.siteCookie = siteCookieInput.trim()
          const response = await fetch(`${PREFIX}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
          applyState(data)
          setKeyInput('')
          setSiteCookieInput('')
          setStatus('已保存')
        } catch (err) {
          setError(`保存失败：${err && err.message ? err.message : err}`)
        } finally {
          setBusy(false)
        }
      }, [applyState, enabled, keyInput, siteCookieInput, autoCheckIn, maxChars, voiceId, instructions, speed, volume, audioTags])

      const clearKey = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const response = await fetch(`${PREFIX}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clearKey: true }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
          applyState(data)
          setStatus('KEY 已清除')
        } catch (err) {
          setError(`操作失败：${err && err.message ? err.message : err}`)
        } finally {
          setBusy(false)
        }
      }, [applyState])

      const preview = React.useCallback(async () => {
        setTrying(true)
        setError('')
        try {
          const response = await fetch(`${PREFIX}/preview`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: '语音播报试听，一二三四五。', instructions: instructions.trim() }),
          })
          if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
          }
          const blob = await response.blob()
          const url = URL.createObjectURL(blob)
          try {
            await playBlob(url)
          } finally {
            URL.revokeObjectURL(url)
          }
        } catch (err) {
          setError(`试听失败：${err && err.message ? err.message : err}`)
        } finally {
          setTrying(false)
        }
      }, [])

      const refreshCredits = React.useCallback(async (force = false) => {
        try {
          const response = await fetch(`${PREFIX}/credits${force ? '?force=1' : ''}`, { headers: { accept: 'application/json' } })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
          if (data.credits) setCredits(data.credits)
          setCreditsNote(data.creditsNote || '')
          if (data.cookie) setSiteCookieState(data.cookie)
          if (data.lastCheckInDate) setCreditState((prev) => ({ ...prev, lastCheckInDate: data.lastCheckInDate }))
          if (data.state && data.state.at) setCreditState((prev) => ({ ...prev, state: data.state }))
        } catch (err) {
          setCreditsNote(`读取积分失败：${err && err.message ? err.message : err}`)
        }
      }, [])

      const checkInNow = React.useCallback(async () => {
        setChecking(true)
        setStatus('')
        setError('')
        try {
          const response = await fetch(`${PREFIX}/credits`, { method: 'POST', headers: { accept: 'application/json' } })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
          if (data.state) setCreditState((prev) => ({ ...prev, state: data.state, lastCheckInDate: data.date || prev.lastCheckInDate }))
          if (data.ok) setStatus(data.note || '签到完成')
          else setError(data.reason || data.note || '签到没成功')
          await refreshCredits(true)
        } catch (err) {
          setError(`签到失败：${err && err.message ? err.message : err}`)
        } finally {
          setChecking(false)
        }
      }, [refreshCredits])

      React.useEffect(() => {
        const timer = setTimeout(() => {
          void refreshCredits(false)
        }, 800)
        return () => clearTimeout(timer)
      }, [refreshCredits])

      const pasteCookie = React.useCallback(async () => {
        try {
          const text = await navigator.clipboard.readText()
          if (text && text.trim()) {
            setSiteCookieInput(text.trim())
            setStatus('已从剪贴板读入，记得点「保存」')
          } else setError('剪贴板是空的')
        } catch (err) {
          setError(`读剪贴板失败：${err && err.message ? err.message : err}（可以手动粘贴）`)
        }
      }, [])

      const clearCookie = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const response = await fetch(`${PREFIX}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clearSiteCookie: true }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
          applyState(data)
          setStatus('站点 Cookie 已清除')
        } catch (err) {
          setError(`操作失败：${err && err.message ? err.message : err}`)
        } finally {
          setBusy(false)
        }
      }, [applyState])

      return h(
        'div',
        { style: css.box },
        autoCheckIn && siteCookieState.configured
          ? h(
              'div',
              { style: css.hero },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
                h('div', { style: css.heroNumber }, credits && credits.balance != null ? String(credits.balance) : '—'),
                h('div', { style: css.heroUnit }, '积分'),
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-end' } },
                h(
                  'div',
                  { style: css.heroMeta },
                  credits
                    ? credits.claimedToday
                      ? '今天已签到'
                      : credits.claimAvailable
                        ? `今天可领 ${credits.claimAmount == null ? '' : credits.claimAmount}`
                        : '今天还没签到'
                    : creditsNote || '读取中…',
                ),
                credits && credits.consumedTotal != null
                  ? h('div', { style: css.heroMeta }, `累计领 ${credits.grantedTotal} · 已用 ${credits.consumedTotal}`)
                  : null,
              ),
            )
          : null,
        h(
          'div',
          { style: css.col },
          h('div', { style: css.title }, '回复语音播报'),
          h(
            'p',
            { style: css.hint },
            '每轮回复结束前，大肥鱼会把结论压成一句话交给语音念出来；音频只在内存里过一手，不落盘、播完即删。',
          ),
        ),
        h('hr', { style: css.divider }),
        h(
          'div',
          { style: css.row },
          h(
            'div',
            { style: css.col },
            h('div', { style: css.title }, '开启语音播报'),
            h('p', { style: css.hint }, '关掉之后连 voice_say 工具都不会出现，也不会发出任何请求。'),
          ),
          h('input', {
            type: 'checkbox',
            style: css.check,
            checked: enabled,
            onChange: (event) => setEnabled(Boolean(event.target.checked)),
            'aria-label': '开启语音播报',
          }),
        ),
        h(
          'div',
          { style: css.row },
          h(
            'div',
            { style: css.col },
            h('div', { style: css.title }, '每轮总结字数（给大肥鱼看的要求）'),
            h('p', { style: css.hint }, '按每轮真正的结论写，不是寒暄。这是大肥鱼写作时的字数要求，不会拿去截断语音——超了照样整句播，只会在结果里提示它写短点。'),
          ),
          h('input', {
            type: 'number',
            min: 1,
            max: 200,
            style: { ...css.input, minWidth: '88px', width: '88px' },
            value: maxChars,
            onChange: (event) => setMaxChars(event.target.value),
            'aria-label': '每轮最多字数',
          }),
        ),
        h(
          'div',
          { style: css.col },
          h('div', { style: css.title }, '音色 ID'),
          h('input', {
            type: 'text',
            style: css.input,
            value: voiceId,
            onChange: (event) => setVoiceId(event.target.value),
            placeholder: 'voc_8yud7hz7c9q2',
            spellCheck: false,
          }),
          h(
            'p',
            { style: css.hint },
            '默认是 ',
            h('code', null, 'voc_8yud7hz7c9q2'),
            '。想换音色可以到 ',
            h('a', { href: VOICE_LINK, target: '_blank', rel: 'noreferrer', style: css.link }, 'breezeblue.ai 音色库'),
            ' 复制音色 ID 粘进来。',
          ),
        ),
        h(
          'div',
          { style: css.col },
          h('div', { style: css.title }, '说话语气'),
          h('textarea', {
            style: { ...css.input, minHeight: '62px', resize: 'vertical', lineHeight: '1.5' },
            value: instructions,
            onChange: (event) => setInstructions(event.target.value),
            placeholder: '例：语气轻快、俏皮，像跟熟人随口聊天，句子短。',
            spellCheck: false,
          }),
          h(
            'p',
            { style: css.hint },
            '这是发给 Breeze 的表演指令（instructions），写情景、意图和情绪强度最有效，用中文写；留空则不加指令。',
          ),
        ),
        h(
          'div',
          { style: css.row },
          h(
            'div',
            { style: css.col },
            h('div', { style: css.title }, '语速'),
            h('p', { style: css.hint }, '0.5–2.0，1 是原速；口播提示感强一点可以用 1.1 左右。'),
          ),
          h('input', {
            type: 'number',
            min: 0.5,
            max: 2,
            step: 0.05,
            style: { ...css.input, minWidth: '88px', width: '88px' },
            value: speed,
            onChange: (event) => setSpeed(event.target.value),
            'aria-label': '语速',
          }),
        ),
        h(
          'div',
          { style: css.row },
          h(
            'div',
            { style: css.col },
            h('div', { style: css.title }, '音量'),
            h('p', { style: css.hint }, '0.01–2.0，1 是原始音量；这是信号级倍数，太大可能削顶。'),
          ),
          h('input', {
            type: 'number',
            min: 0.01,
            max: 2,
            step: 0.05,
            style: { ...css.input, minWidth: '88px', width: '88px' },
            value: volume,
            onChange: (event) => setVolume(event.target.value),
            'aria-label': '音量',
          }),
        ),
        h(
          'div',
          { style: css.row },
          h(
            'div',
            { style: css.col },
            h('div', { style: css.title }, '允许音频标签'),
            h(
              'p',
              { style: css.hint },
              '开启后大肥鱼会在句子里加方括号标签，如 [轻笑]、[叹气]、[停顿]、[耳语]，由模型合成成笑声、叹息这类声音。',
            ),
          ),
          h('input', {
            type: 'checkbox',
            style: css.check,
            checked: audioTags,
            onChange: (event) => setAudioTags(Boolean(event.target.checked)),
            'aria-label': '允许音频标签',
          }),
        ),
        h('hr', { style: css.divider }),
        h(
          'div',
          { style: css.col },
          h('div', { style: css.title }, 'API KEY'),
          h('input', {
            type: 'password',
            style: css.input,
            value: keyInput,
            onChange: (event) => setKeyInput(event.target.value),
            placeholder: keyState.configured ? `已保存 ${keyState.masked}（留空则不改）` : '粘贴 Breeze API Key',
            spellCheck: false,
            autoComplete: 'off',
          }),
          h(
            'p',
            { style: css.hint },
            'KEY 存在 DSH 的凭据库里，不会写进配置或日志。还没有 KEY？',
            h('a', { href: VOICE_LINK, target: '_blank', rel: 'noreferrer', style: css.link }, '点击获取 API'),
            keyState.configured
              ? h(
                  'span',
                  null,
                  ' · ',
                  h(
                    'a',
                    {
                      href: '#',
                      style: css.link,
                      onClick: (event) => {
                        event.preventDefault()
                        if (!busy) clearKey()
                      },
                    },
                    '清除已保存的 KEY',
                  ),
                )
              : null,
          ),
        ),
        h('hr', { style: css.divider }),
        h(
          'div',
          { style: css.col },
        h(
          'div',
          { style: css.row },
          h('div', { style: css.title }, '每日签到领积分'),
          creditsNote ? h('span', { style: css.bad }, creditsNote) : null,
        ),
          h(
            'p',
            { style: css.hint },
            '每天打开 DKH 时自动去 breezeblue.ai 点一次签到。签到接口只认网站登录态 Cookie，不认 API KEY，所以要单独填一次 Cookie（大约能用一两个月，过期了这里会提示）。',
          ),
        ),
        h(
          'div',
          { style: css.row },
          h(
            'div',
            { style: css.col },
            h('div', { style: css.title }, '打开 DKH 自动签到'),
            h('p', { style: css.hint }, `上次处理：${creditState.lastCheckInDate || '还没签过'}`),
          ),
          h('input', {
            type: 'checkbox',
            style: css.check,
            checked: autoCheckIn,
            onChange: (event) => setAutoCheckIn(Boolean(event.target.checked)),
            'aria-label': '打开 DKH 自动签到',
          }),
        ),
        h(
          'div',
          { style: css.col },
          h('div', { style: css.title }, '站点 Cookie'),
          h('textarea', {
            style: { ...css.input, minHeight: '54px', resize: 'vertical', fontFamily: 'monospace', fontSize: '12px' },
            value: siteCookieInput,
            onChange: (event) => setSiteCookieInput(event.target.value),
            placeholder: siteCookieState.configured ? '已保存 Cookie（重新粘贴会覆盖）' : '粘贴整段 Cookie：name=value; name2=value2',
            spellCheck: false,
          }),
          h(
            'p',
            { style: css.hint },
            '获取方式：浏览器登录 breezeblue.ai → F12 → Network → 随便点一个 /api 请求 → Request Headers 里复制整行 Cookie。',
            h(
              'a',
              { href: `${VOICE_LINK}`, target: '_blank', rel: 'noreferrer', style: css.link },
              '  先去登录站点',
            ),
          ),
          h(
            'div',
            { style: { ...css.row, justifyContent: 'flex-start', gap: '10px' } },
            h('button', { type: 'button', style: css.button, disabled: busy, onClick: pasteCookie }, '从剪贴板读取'),
            h(
              'button',
              { type: 'button', style: css.button, disabled: busy || checking, onClick: checkInNow },
              checking ? '签到中…' : '立即签到',
            ),
            siteCookieState.configured
              ? h('button', { type: 'button', style: css.button, disabled: busy, onClick: clearCookie }, '清除 Cookie')
              : null,
          ),
          creditState.state
            ? h(
                'p',
                { style: creditState.state.ok ? css.ok : css.bad },
                `${creditState.state.ok ? '✅' : '⚠️'} ${creditState.state.note || ''}`,
              )
            : null,
        ),
        h(
          'div',
          { style: { ...css.row, justifyContent: 'flex-start', gap: '10px' } },
          h(
            'button',
            { type: 'button', style: css.button, disabled: busy || !loaded, onClick: save },
            busy ? '保存中…' : '保存',
          ),
          h(
            'button',
            { type: 'button', style: css.button, disabled: trying, onClick: preview },
            trying ? '试听中…' : '试听一句',
          ),
        ),
        status ? h('div', { style: css.ok }, status) : null,
        error ? h('div', { style: css.bad }, error) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => startPlayer(ctx))
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-tts-voice',
              order: 60,
              label: '语音播报',
            },
            VoiceSettings,
          ),
        )
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register(
            {
              name: 'settings.section.icon',
              id: 'dsh-tts-voice',
              order: 60,
            },
            Icon,
          ),
        )
      },
    }
  },
})
