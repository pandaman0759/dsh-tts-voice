// @local/dsh-tts-voice — host half.
//
// 每轮回复结束前，模型调用 `voice_say` 把一句总结交给本插件；
// 浏览器里的 client half 轮询取走文本、向本插件的同源路由要音频、
// 用 Audio + Blob URL 播放，播完 ack 并释放对象 URL。
// 音频只在内存里过一手：不落盘、不写库、播完即删。

const API_BASE = 'https://api.breeze.blue'
const KEY_REF = 'BREEZE_TTS_API_KEY'
const PREFIX = '/api/dsh-tts-voice'
const VOICE_LINK = 'https://breezeblue.ai/zh?code=7JXP7Y'
const ENTRY_ID = 'dsh-tts-voice'

/** Breeze 单个请求的硬上限（未审批账号 1000 字符）。 */
const MAX_REQUEST_CHARS = 900
/** 一条待播文本最多等多久（秒），超时直接丢弃。 */
const QUEUE_TTL_MS = 120_000
/** 同一条被某个页面取走后，多少毫秒内不再发给别的页面。 */
const CLAIM_MS = 15_000
const QUEUE_MAX = 12

export const inject = ['tools', 'webServer']

export function apply(ctx, config) {
  const dbg = async (line) => {
    if (process.env.DSH_TTS_DEBUG !== '1') return
    try {
      const fs = await import('node:fs/promises')
      const os = await import('node:os')
      const path = await import('node:path')
      const file = path.join(os.tmpdir(), 'dsh-tts-voice-debug.log')
      await fs.appendFile(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      /* ignore */
    }
  }

  const queue = []
  /** 最近一次播放回执，只用于自检（设置页/命令行都看不到音频本体）。 */
  let lastOutcome = null
  let log = () => {}
  try {
    // 宿主不同版本的 ctx.logger 有时返回函数、有时返回 {info,warn,error} 对象，
    // 之前直接把返回值当函数调，合成失败路径上抛 TypeError 把真正的错误盖掉。
    const raw = typeof ctx.logger === 'function' ? ctx.logger('dsh-tts-voice') : null
    if (typeof raw === 'function') {
      log = (level, message) => {
        try {
          raw(level, message)
        } catch {
          /* ignore */
        }
      }
    } else if (raw && typeof raw === 'object') {
      log = (level, message) => {
        try {
          const fn = raw[level] || raw.log || raw.info
          if (typeof fn === 'function') fn.call(raw, message)
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    log = () => {}
  }

  /** 只数字数（不计 `[轻笑]` 这类音频标签），用来判断本轮总结有没有超出建议字数。 */
  function visibleLength(text) {
    let visible = 0
    let i = 0
    const openOf = (ch) => (ch === '[' ? ']' : ch === '(' ? ')' : '')
    while (i < text.length) {
      const ch = text[i]
      const closer = openOf(ch)
      if (closer) {
        const close = text.indexOf(closer, i)
        if (close > i) {
          i = close + 1
          continue
        }
      }
      visible += 1
      i += 1
    }
    return visible
  }

  /**
   * 按可见字数截断：`[轻笑]`/`(sighs)` 这类音频标签不计入字数，也绝不被切开
   * （切一半的 `[轻` 会被念成静默或报错）。截断点之后若只剩标签，顺手带上。
   */
  function clampText(text, max) {
    const limit = Math.max(1, Math.floor(Number(max) || 20))
    let out = ''
    let visible = 0
    let i = 0
    const openOf = (ch) => (ch === '[' ? ']' : ch === '(' ? ')' : '')
    while (i < text.length) {
      const ch = text[i]
      const closer = openOf(ch)
      if (closer) {
        const close = text.indexOf(closer, i)
        if (close > i) {
          out += text.slice(i, close + 1)
          i = close + 1
          continue
        }
      }
      if (visible >= limit) {
        while (i < text.length) {
          const tail = text[i]
          const tailCloser = openOf(tail)
          if (tailCloser) {
            const close = text.indexOf(tailCloser, i)
            if (close > i) {
              out += text.slice(i, close + 1)
              i = close + 1
              continue
            }
          }
          if (/\s/.test(tail)) {
            i += 1
            continue
          }
          break
        }
        break
      }
      out += ch
      visible += 1
      i += 1
    }
    return out.trim()
  }

  const settings = () => {
    const c = config || {}
    const maxChars = Number(c.maxChars)
    const speed = Number(c.speed)
    const volume = Number(c.volume)
    return {
      enabled: c.enabled !== false,
      maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 20,
      voiceId: typeof c.voiceId === 'string' && c.voiceId.trim() ? c.voiceId.trim() : 'voc_8yud7hz7c9q2',
      modelId: typeof c.modelId === 'string' && c.modelId.trim() ? c.modelId.trim() : 'breeze-tts-2-multilingual',
      languageCode: typeof c.languageCode === 'string' && c.languageCode.trim() ? c.languageCode.trim() : 'zh',
      instructions:
        typeof c.instructions === 'string' && c.instructions.trim()
          ? c.instructions.trim()
          : '语气轻快、俏皮，像跟熟人随口聊天，句子短，句尾自然收住。',
      speed: Number.isFinite(speed) ? Math.min(2, Math.max(0.5, speed)) : 1,
      volume: Number.isFinite(volume) ? Math.min(2, Math.max(0.01, volume)) : 0.9,
      audioTags: c.audioTags !== false,
      autoCheckIn: c.autoCheckIn !== false,
      lastCheckInDate: typeof c.lastCheckInDate === 'string' ? c.lastCheckInDate : '',
    }
  }

  async function resolveKey() {
    const credentials = ctx.get('credentials')
    if (credentials) {
      try {
        const resolved = await credentials.resolve(KEY_REF)
        if (resolved && resolved.value) return resolved.value.trim()
      } catch (error) {
        log('warn', `读取凭据失败：${String(error && error.message ? error.message : error)}`)
      }
    }
    const fromConfig = typeof config?.apiKey === 'string' ? config.apiKey.trim() : ''
    if (fromConfig) return fromConfig
    const fromEnv = (process.env.BREEZE_API_KEY || process.env.BREEZE_TTS_API_KEY || '').trim()
    return fromEnv
  }

  function maskKey(key) {
    if (!key) return ''
    if (key.length <= 8) return `${key.slice(0, 2)}****`
    return `${key.slice(0, 4)}****${key.slice(-4)}`
  }

  function sweep() {
    const now = Date.now()
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const item = queue[i]
      const expired = now - item.createdAt > QUEUE_TTL_MS
      const gone = item.claimedAt && now - item.claimedAt > QUEUE_TTL_MS
      if (expired || gone) queue.splice(i, 1)
    }
    while (queue.length > QUEUE_MAX) queue.shift()
  }

  function enqueue(text, instructions) {
    sweep()
    const direction = typeof instructions === 'string' ? instructions.trim().slice(0, 1000) : ''
    // 一秒内连续两句（比如工具补救又补一句）直接并成一句，免得前一句刚播完
    // 后一句紧接着又响，听感像被打断；已经取走（claimedAt）的条目不动。
    const last = queue[queue.length - 1]
    if (last && !last.claimedAt && !last.audio && Date.now() - last.createdAt < 1200) {
      const merged = `${last.text}${/[。！？!?…,，]$/.test(last.text) ? '' : '，'}${text}`
      if (merged.length <= MAX_REQUEST_CHARS) {
        last.text = merged
        last.createdAt = Date.now()
        if (direction) last.instructions = direction
        return last
      }
    }
    const item = {
      id: (globalThis.crypto?.randomUUID?.() ?? `tts-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      text,
      instructions: direction,
      createdAt: Date.now(),
      claimedAt: 0,
      audio: null,
      contentType: 'audio/mpeg',
    }
    queue.push(item)
    return item
  }

  async function synthesize(text, instructions) {
    const c = settings()
    const key = await resolveKey()
    if (!key) throw new Error('未配置 Breeze API Key')
    const url = `${API_BASE}/v1/text-to-speech/${encodeURIComponent(c.voiceId)}?output_format=mp3`
    const direction = (typeof instructions === 'string' && instructions.trim() ? instructions.trim() : c.instructions || '').slice(0, 1000)
    const payload = {
      text: text.slice(0, MAX_REQUEST_CHARS),
      language_code: c.languageCode,
      model_id: c.modelId,
      voice_settings: { speed: c.speed, volume: c.volume, guidance_scale: 2 },
    }
    if (direction) payload.instructions = direction
    // 合成失败重试一次：短时间内连着两句话时 Breeze 偶尔会限流或超时，
    // 以前直接判失败、页面那一条就彻底没声了。
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'xi-api-key': key,
            'content-type': 'application/json',
            accept: 'audio/mpeg',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(90_000),
        })
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          const error = new Error(`Breeze ${response.status}：${detail.slice(0, 300)}`)
          error.status = response.status
          throw error
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length === 0) throw new Error('Breeze 返回了空音频')
        return { buffer, contentType: response.headers.get('content-type') || 'audio/mpeg' }
      } catch (error) {
        lastError = error
        const status = error && typeof error.status === 'number' ? error.status : 0
        // 明确的客户端错误（key 不对、参数不合法）重试也没用，直接放弃。
        if (status === 400 || status === 401 || status === 403 || status === 404) break
        // 超时说明 Breeze 正在排队（连续多次合成后会明显变慢），再等一轮只会更久，直接放弃。
        if (/abort|timeout/i.test(String(error && error.message ? error.message : error))) break
        log('warn', `合成第 ${attempt + 1} 次失败：${String(error && error.message ? error.message : error)}`)
        await new Promise((resolve) => setTimeout(resolve, 700))
      }
    }
    throw lastError || new Error('合成失败')
  }

  // ---------------------------------------------------------------- tool

  if (ctx.tools) {
    ctx.effect(() =>
      ctx.tools.register(
        {
          name: 'voice_say',
          description:
            '每轮回复结束前调用一次：把这一轮真正做完/给出的结论压成一句话，用语音念出来（相当于语音播报）。'
            + '只放结论，不要寒暄、不要复述全文；字数上限（设置页里那个数，默认 20）是给模型的写作要求，不是播报的截断线——'
            + '超过上限不会被截断，会整句照播并在结果里提醒你超了几字，所以请自己压到上限以内再调用。'
            + '中文里可以用方括号音频标签替代语气词，例如 [轻笑] [咯咯笑] [叹气] [耳语] [停顿] [咂嘴] [哼歌] [冷笑] [闷哼] [咳嗽] [打哈欠]；'
            + '中文文本只能用方括号标签，不要混用英文圆括号写法（如（笑）会被当普通文字读出来）。'
            + '需要临时改变这一句的语气时，用 instructions 传一句中文表演指令（如「小声嘀咕，有点不服气」）。'
            + '这是每一轮的结束提示音：不论这轮是干活、闲聊、报错还是只回一句「在的」，在最终回复输出之前都必须调用一次，不能省略。'
            + '这一轮没有实质结论时，就播一句简短的收尾（例如「[轻笑] 在的，你说。」「[停顿] 那就先这样。」），仍然要调用。',
          parameters: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: '要念出来的一句话总结（中文；把结论压到设置页上限的字数以内，可带方括号音频标签）',
              },
              instructions: {
                type: 'string',
                description: '可选：这一句的中文表演指令，描述情景、意图与情绪强度，如「说得很轻，像怕被人听见」。留空则用设置页里的默认语气。',
              },
            },
            required: ['text'],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                queued: { type: 'boolean' },
                spoken: { type: 'string' },
                visibleChars: { type: 'number' },
                overLimit: { type: 'number' },
                reason: { type: 'string' },
              },
            },
            render(_args, value) {
              const v = value || {}
              if (!v.ok) return [{ type: 'text', text: `语音未播放：${v.reason || '未知原因'}` }]
              const note = v.overLimit > 0
                ? `（超出建议字数 ${v.overLimit} 字，下次写短一点；这句照样完整播了）`
                : ''
              return [{ type: 'text', text: `语音已入队：${v.spoken}${note}` }]
            },
          },
          async execute(args) {
            const c = settings()
            if (!c.enabled) return { ok: false, queued: false, reason: '语音播报开关已关闭' }
            const raw = typeof args?.text === 'string' ? args.text.trim() : ''
            if (!raw) return { ok: false, queued: false, reason: 'text 为空' }
            if (raw.length > MAX_REQUEST_CHARS) {
              return { ok: false, queued: false, reason: `这句话太长了（${raw.length} 字符），请压到 ${c.maxChars} 字以内再调用` }
            }
            const key = await resolveKey()
            if (!key) return { ok: false, queued: false, reason: '设置页里还没有填 Breeze API Key' }
            const direction = typeof args?.instructions === 'string' ? args.instructions.trim() : ''
            const visibleChars = visibleLength(raw)
            const overLimit = Math.max(0, visibleChars - Math.max(1, Number(c.maxChars) || 20))
            enqueue(raw, direction)
            return { ok: true, queued: true, spoken: raw, visibleChars, overLimit }
          },
        },
        { when: () => settings().enabled },
      ),
    )
  }

  // 语音规则常驻系统提示：只写在工具描述里模型会漏（新窗口开场最容易漏），
  // 所以照 dsh-meme 的做法，在 system-prompt/assemble 里追加一段固定规则。
  const VOICE_RULE =
    '语音播报规则：每轮回复结束前都要调用一次 voice_say，把这一轮的结论压成一句话念出来（相当于结束提示音）。'
    + '不论这一轮是干活、闲聊、报错，还是只回一句「在的」，在最终回复输出之前都必须调用一次，不能省略；'
    + '没有实质结论时就播一句简短收尾，例如「[轻笑] 在的，你说。」「[停顿] 那就先这样。」。'
    + '设置页里的字数上限是给模型写总结的要求，不是播报的截断线——超了照样整句播，只在结果里提示超了几字，所以请自己压到上限以内再调用。'
    + '中文文本可以用方括号音频标签，如 [轻笑] [叹气] [停顿] [耳语]。'

  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    try {
      const c = settings()
      if (!c.enabled) return assembled
      if (assembled && Array.isArray(assembled.sections)) {
        assembled.sections.push({ name: 'dsh-tts-voice:rule', text: VOICE_RULE })
      } else {
        log('warn', 'system-prompt: sections 不是数组，语音规则没注入')
      }
    } catch (error) {
      log('warn', `system-prompt 注入失败：${String(error && error.message ? error.message : error)}`)
    }
    return assembled
  })

  // ------------------------------------------------------- daily credits
  //
  // 签到走网页端接口 `/api/credits/daily-claim`（不在 /v1 文档里）。
  // 实测：`xi-api-key` 与 `Authorization: Bearer <apiKey>` 两种写法都被判 401 AUTH_REQUIRED
  // —— 这个接口只认网站登录态 Cookie，所以站点 Cookie 单独存凭据库，跟 API KEY 分开。

  const WEB_BASE = 'https://breezeblue.ai'
  const COOKIE_REF = 'BREEZE_SITE_COOKIE'

  let checkInState = { at: null, ok: null, note: '', text: '' }

  async function siteCookie() {
    const credentials = ctx.get('credentials')
    if (!credentials) return ''
    try {
      const record = await credentials.resolve(COOKIE_REF)
      return record && typeof record.value === 'string' ? record.value.trim() : ''
    } catch {
      return ''
    }
  }

  async function siteFetch(path, init = {}) {
    const cookie = await siteCookie()
    if (!cookie) throw new Error('还没有保存站点登录 Cookie')
    const response = await fetch(`${WEB_BASE}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        origin: WEB_BASE,
        referer: `${WEB_BASE}/zh`,
        ...(init.headers || {}),
        cookie,
      },
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    return { status: response.status, text }
  }

  const localDate = () => {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }

  /** 最近一次积分信息：设置页打开时直接读缓存，过期或手动刷新才打站点接口。 */
  let creditsCache = { at: null, value: null, note: '' }

  const parseSummary = (text) => {
    try {
      const data = JSON.parse(text)
      return {
        balance: typeof data.balance === 'number' ? data.balance : null,
        grantedTotal: typeof data.granted_total === 'number' ? data.granted_total : null,
        consumedTotal: typeof data.consumed_total === 'number' ? data.consumed_total : null,
        claimedToday: data.daily_claim_claimed_today === true,
        claimAvailable: data.daily_claim_available === true,
        claimAmount: typeof data.daily_claim_amount === 'number' ? data.daily_claim_amount : null,
        standardAmount: typeof data.daily_claim_standard_amount === 'number' ? data.daily_claim_standard_amount : null,
        nextResetAt: typeof data.daily_claim_next_reset_at === 'string' ? data.daily_claim_next_reset_at : '',
      }
    } catch {
      return null
    }
  }

  /** 读站点积分；60 秒内复用缓存，force 才重新请求。 */
  async function refreshCredits(force = false) {
    const now = Date.now()
    if (!force && creditsCache.value && creditsCache.at && now - creditsCache.at < 60_000) return creditsCache.value
    try {
      const summary = await siteFetch('/api/credits/summary')
      if (summary.status === 401 || summary.status === 403) {
        creditsCache = { at: now, value: null, note: '站点 Cookie 失效，需要重新复制' }
        return null
      }
      if (summary.status !== 200) {
        creditsCache = { at: now, value: null, note: `读取积分失败（HTTP ${summary.status}）` }
        return null
      }
      const parsed = parseSummary(summary.text)
      creditsCache = { at: now, value: parsed, note: parsed ? '' : '积分接口返回的内容无法解析' }
      return parsed
    } catch (error) {
      creditsCache = { at: now, value: null, note: String(error && error.message ? error.message : error) }
      return null
    }
  }

  /** 每天最多尝试一次：先读 summary，再 POST daily-claim；失败原因原样留着给设置页看。 */
  async function checkIn(force = false) {
    const c = settings()
    if (!c.autoCheckIn && !force) return { ok: true, skipped: '自动签到已关闭' }
    const today = localDate()
    if (!force && c.lastCheckInDate === today) return { ok: true, skipped: '今天已经签过了', date: today }
    let note = ''
    try {
      const before = await refreshCredits(true)
      if (!before && /失效/.test(creditsCache.note)) {
        checkInState = { at: Date.now(), ok: false, note: creditsCache.note, text: '' }
        return { ok: false, reason: checkInState.note }
      }
      const claim = await siteFetch('/api/credits/daily-claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const body = claim.text.slice(0, 400)
      let claimed = null
      try {
        claimed = JSON.parse(claim.text)
      } catch {
        claimed = null
      }
      const already = /ALREADY|already|已领取|今日/.test(claim.text)
      const success = claim.status === 200 && !(claimed && claimed.ok === false) && !already
      note = success
        ? '签到成功'
        : already
          ? '今天已经领过了'
          : claim.status === 200
            ? '接口返回了非成功内容'
            : `签到失败（HTTP ${claim.status}）`
      checkInState = { at: Date.now(), ok: success || already, note, text: body }
      if (success || already) {
        await writeConfig({ lastCheckInDate: today }).catch(() => {})
        await refreshCredits(true)
      }
      return {
        ok: success || already,
        note,
        date: today,
        credits: claimed,
        balance: creditsCache.value ? creditsCache.value.balance : null,
        raw: body,
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      checkInState = { at: Date.now(), ok: false, note: message, text: '' }
      return { ok: false, reason: message }
    }
  }

  // --------------------------------------------------------------- routes

  const readJson = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }

  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  async function writeConfig(patch) {
    const editor = ctx.get('configEditor')
    if (!editor) throw new Error('configEditor 服务不可用')
    const own = ctx.fiber?.entry
    let entry = own
    if (!entry && typeof editor.entries === 'function') {
      const entries = editor.entries()
      entry =
        entries.find((item) => item === own) ||
        entries.find((item) => item.patchId === ENTRY_ID) ||
        entries.find((item) => item.id === `include:${ENTRY_ID}`) ||
        entries.find((item) => item.name === '@local/dsh-tts-voice')
    }
    if (!entry) throw new Error(`找不到配置行 ${ENTRY_ID}`)
    await editor.edit(entry, (current) => ({ ...current, ...patch }))
  }

  async function keyStatus() {
    const credentials = ctx.get('credentials')
    let key = await resolveKey()
    let source = key ? 'environment' : 'none'
    if (credentials) {
      try {
        const info = await credentials.describe(KEY_REF)
        if (info && info.configured) source = 'stored'
      } catch {
        /* describe 不可用时只看解析结果 */
      }
    }
    if (!key && source === 'environment') source = 'none'
    return { configured: Boolean(key), masked: maskKey(key), source }
  }

  if (ctx.webServer) {
    ctx.effect(() => {
      const disposers = []

      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/credits`,
          handler: async (req, res) => {
            const c = settings()
            const cookie = await siteCookie()
            if (req.method === 'POST') {
              const result = await checkIn(true)
              return sendJson(res, 200, { ...result, state: checkInState })
            }
            if (!cookie) {
              return sendJson(res, 200, {
                cookie: { configured: false },
                autoCheckIn: c.autoCheckIn,
                lastCheckInDate: c.lastCheckInDate,
                state: checkInState,
                credits: null,
                creditsNote: '还没填站点 Cookie',
                hint: '站点接口只认登录 Cookie：先在浏览器登录 breezeblue.ai，再把 Cookie 粘贴进来。',
              })
            }
            const credits = await refreshCredits(false)
            const today = localDate()
            const stateOut =
              checkInState.at || !c.lastCheckInDate || c.lastCheckInDate !== today
                ? checkInState
                : { at: null, ok: true, note: '今天已经签过了', text: '' }
            sendJson(res, 200, {
              cookie: { configured: true },
              autoCheckIn: c.autoCheckIn,
              lastCheckInDate: c.lastCheckInDate,
              state: stateOut,
              credits,
              creditsNote: creditsCache.note,
              creditsAt: creditsCache.at,
            })
          },
        }),
      )

      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/next`,
          handler: async (_req, res) => {
            if (!settings().enabled) return sendJson(res, 200, { pending: null })
            sweep()
            const now = Date.now()
            const item = queue.find((entry) => !entry.claimedAt || now - entry.claimedAt > CLAIM_MS)
            if (!item) return sendJson(res, 200, { pending: null })
            item.claimedAt = now
            sendJson(res, 200, {
              pending: { id: item.id, text: item.text, voiceId: settings().voiceId },
            })
          },
        }),
      )

      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/audio`,
          handler: async (req, res) => {
            void dbg(`audio enter ${req.method} ${req.url}`)
            try {
              const url = new URL(req.url || PREFIX, 'http://127.0.0.1')
              const id = url.searchParams.get('id') || ''
              const item = queue.find((entry) => entry.id === id)
              if (!item) return sendJson(res, 404, { error: '这条语音已经不在了' })
              if (item.audio) void dbg(`audio cache-hit ${id} ${item.audio.length}`)
              if (!item.audio) {
                // 同一句被多个页面同时索要时共用一次合成，避免并发打到 Breeze 再各自失败
                if (!item.synth) {
                  item.synth = synthesize(item.text, item.instructions)
                  item.synth.catch(() => {
                    item.synth = null
                  })
                }
                const { buffer, contentType } = await item.synth
                item.audio = buffer
                item.contentType = contentType
                void dbg(`audio synthesized ${id} ${buffer.length}`)
              }
              res.writeHead(200, {
                'content-type': item.contentType,
                'content-length': item.audio.length,
                'cache-control': 'no-store',
              })
              res.end(item.audio)
            } catch (error) {
              const message = String(error && error.message ? error.message : error)
              void dbg(`audio error ${message} | stack=${(error && error.stack ? error.stack : '').split('\n').slice(0, 4).join(' / ')}`)
              log('warn', `合成失败：${message}`)
              // 响应已经开始写（客户端断开、流已结束）时不能再写头，否则框架会把二次写入转成 400 空响应
              if (res.headersSent || res.writableEnded) {
                try {
                  res.end()
                } catch {
                  /* ignore */
                }
                return
              }
              if (/未配置/.test(message)) return sendJson(res, 400, { error: message })
              if (/401|403/.test(message)) return sendJson(res, 502, { error: message })
              sendJson(res, 502, { error: message })
            }
          },
        }),
      )

      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/ack`,
          handler: async (req, res) => {
            const body = await readJson(req)
            const id = body && typeof body.id === 'string' ? body.id : ''
            const index = queue.findIndex((entry) => entry.id === id)
            const removed = index >= 0 ? queue.splice(index, 1)[0] : null
            lastOutcome = {
              id,
              text: removed ? removed.text : '',
              outcome: typeof body.outcome === 'string' ? body.outcome : 'unknown',
              note: typeof body.note === 'string' ? body.note.slice(0, 300) : '',
              at: new Date().toISOString(),
            }
            sendJson(res, 200, { ok: true })
          },
        }),
      )

      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/config`,
          handler: async (req, res) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
              try {
              const c = settings()
              return sendJson(res, 200, {
                enabled: c.enabled,
                maxChars: c.maxChars,
                voiceId: c.voiceId,
                modelId: c.modelId,
                languageCode: c.languageCode,
                instructions: c.instructions,
                speed: c.speed,
                volume: c.volume,
                audioTags: c.audioTags,
                autoCheckIn: c.autoCheckIn,
                lastCheckInDate: c.lastCheckInDate,
                siteCookie: { configured: Boolean(await siteCookie()) },
                key: await keyStatus(),
                voiceLink: VOICE_LINK,
                creditsLink: `${WEB_BASE}/zh`,
              })
              } catch (error) {
                return sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
              }
            }
            if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 GET/POST' })
            const body = await readJson(req)
            const patch = {}
            if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
            if (body.maxChars !== undefined) {
              const n = Number(body.maxChars)
              if (!Number.isFinite(n) || n < 1 || n > 200) {
                return sendJson(res, 400, { error: '字数上限要在 1–200 之间' })
              }
              patch.maxChars = Math.floor(n)
            }
            if (typeof body.voiceId === 'string' && body.voiceId.trim()) patch.voiceId = body.voiceId.trim()
            if (typeof body.modelId === 'string' && body.modelId.trim()) patch.modelId = body.modelId.trim()
            if (typeof body.instructions === 'string') patch.instructions = body.instructions.trim().slice(0, 500)
            if (body.speed !== undefined) {
              const n = Number(body.speed)
              if (!Number.isFinite(n) || n < 0.5 || n > 2) return sendJson(res, 400, { error: '语速要在 0.5–2.0 之间' })
              patch.speed = n
            }
            if (body.volume !== undefined) {
              const n = Number(body.volume)
              if (!Number.isFinite(n) || n < 0.01 || n > 2) return sendJson(res, 400, { error: '音量要在 0.01–2.0 之间' })
              patch.volume = n
            }
            if (typeof body.audioTags === 'boolean') patch.audioTags = body.audioTags
            if (typeof body.autoCheckIn === 'boolean') patch.autoCheckIn = body.autoCheckIn
            const credentials = ctx.get('credentials')
            const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
            const cookieInput = typeof body.siteCookie === 'string' ? body.siteCookie.trim() : ''
            if (body.clearSiteCookie === true) {
              if (!credentials) return sendJson(res, 500, { error: '凭据服务不可用' })
              await credentials.unset(COOKIE_REF)
            } else if (cookieInput) {
              if (!credentials) return sendJson(res, 500, { error: '凭据服务不可用，无法保存 Cookie' })
              await credentials.set(COOKIE_REF, cookieInput)
            }
            if (body.clearKey === true) {
              if (!credentials) return sendJson(res, 500, { error: '凭据服务不可用' })
              await credentials.unset(KEY_REF)
            } else if (apiKey) {
              if (!credentials) return sendJson(res, 500, { error: '凭据服务不可用，无法保存 KEY' })
              await credentials.set(KEY_REF, apiKey)
            }
            if (Object.keys(patch).length > 0) {
              try {
                await writeConfig(patch)
              } catch (error) {
                return sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
              }
            }
            const c = settings()
            const next = { ...patch }
            sendJson(res, 200, {
              ok: true,
              enabled: next.enabled ?? c.enabled,
              maxChars: next.maxChars ?? c.maxChars,
              voiceId: next.voiceId ?? c.voiceId,
              modelId: next.modelId ?? c.modelId,
              languageCode: c.languageCode,
              instructions: next.instructions ?? c.instructions,
              speed: next.speed ?? c.speed,
              volume: next.volume ?? c.volume,
              audioTags: next.audioTags ?? c.audioTags,
              autoCheckIn: next.autoCheckIn ?? c.autoCheckIn,
              lastCheckInDate: c.lastCheckInDate,
              siteCookie: { configured: Boolean(await siteCookie()) },
              key: await keyStatus(),
              voiceLink: VOICE_LINK,
              creditsLink: `${WEB_BASE}/zh`,
            })
          },
        }),
      )

      // 测试探针：手动合成一句话，供设置页「试听」用（不入队、不落盘）。
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/preview`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' })
            const body = await readJson(req)
            const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : '语音播报试听，一二三。'
            const direction = typeof body.instructions === 'string' ? body.instructions : ''
            try {
              const { buffer, contentType } = await synthesize(text.slice(0, MAX_REQUEST_CHARS), direction)
              res.writeHead(200, {
                'content-type': contentType,
                'content-length': buffer.length,
                'cache-control': 'no-store',
              })
              res.end(buffer)
            } catch (error) {
              sendJson(res, 502, { error: String(error && error.message ? error.message : error) })
            }
          },
        }),
      )

      // 自检入口：只在本机回环的页面上可用，用于手动排一句到队列里。
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/say`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' })
            const body = await readJson(req)
            const text = typeof body.text === 'string' ? body.text.trim() : ''
            if (!text) return sendJson(res, 400, { error: 'text 为空' })
            if (!settings().enabled) return sendJson(res, 409, { error: '语音播报开关已关闭' })
            if (!(await resolveKey())) return sendJson(res, 409, { error: '未配置 Breeze API Key' })
            const item = enqueue(text.slice(0, MAX_REQUEST_CHARS), typeof body.instructions === 'string' ? body.instructions : '')
            sendJson(res, 200, { ok: true, id: item.id, text: item.text })
          },
        }),
      )

      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/status`,
          handler: async (_req, res) => {
            sendJson(res, 200, {
              enabled: settings().enabled,
              queue: queue.map((entry) => ({ id: entry.id, text: entry.text, claimed: Boolean(entry.claimedAt) })),
              lastOutcome,
            })
          },
        }),
      )

      const timer = setInterval(sweep, 20_000)
      // 每次启动（= 每次打开 DKH）检查一次签到；当天已处理过就直接跳过。
      const bootCheckIn = setTimeout(() => {
        void checkIn(false).catch(() => {})
      }, 4_000)
      return () => {
        clearTimeout(bootCheckIn)
        clearInterval(timer)
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 重复释放忽略 */
          }
        }
      }
    })
  }
}
