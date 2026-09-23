/**
 * 账号库 —— 把「一个账号」升级成「一库账号，一键切换」。
 *
 * ## 为什么要做（2026-09-12，借鉴 workbuddy-switch）
 *
 * 原来只有一份凭证文件（`deepseek-auth.json`），换号的代价是：
 * **退出 → 清除浏览器分区 → 重新登录 → 等它捕获**，期间原来的号也回不去了。
 * 参考项目把"账号"当成一等公民管理（账号卡片、状态、临期高亮、导入导出），
 * 这里把其中适用的部分搬过来：**多账号并存 + 一键切换 + 导入导出**。
 *
 * 目录结构：
 * ```
 * <DSH_HOME>/web-login/
 *   ├── accounts.json            # 索引：{ activeId }（顺序与展示信息都在各账号文件里）
 *   ├── accounts/acc_xxxx.json   # 每个账号一份（WebAuth + 元信息），原子写 + 0600
 *   └── deepseek-auth.json       # 旧版单账号文件（只用于首次迁移）
 * ```
 *
 * ## ⚠️ 风险提示（必须让使用者看见，不只是写在文档里）
 *
 * 账号库让"换号"变得很容易，而**用多账号轮换规避单账号限流，是有代价的**：
 *
 *  1. 同一服务商会把多账号**关联**起来（同设备、同 IP、同指纹、彼此相近的行为模式）。
 *     一旦被判定为"同一人的多开小号"，处置通常比单账号超频更重，且可能波及**全部**关联账号。
 *  2. 因此本插件**只提供手动切换**，刻意**不做自动轮换** ——
 *     真人不会在几分钟内换一个账号继续发消息，自动换号是极强的机器行为特征，
 *     与本插件在传输层/间隔/会话清理上"降低机器可识别性"的努力**直接冲突**。
 *  3. 账号库里的每个文件都含**可完整登录的凭证**（token + cookie）。
 *     导出的备份文件同样是明文 —— 分享给别人等于把账号给出去。
 *
 * 换句话说：这个功能的目标是「**在你自己的多个正常账号之间切换得更省事**」
 * （比如工作号/个人号），**不是**「靠轮换把限流绕过去」。
 */
import { normalizeCookieMetaList } from './cookies.ts'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { legacyAuthFilePath, webLoginDir } from './paths.ts'
import type { WebAuth } from './auth.ts'

/** 账号库索引。 */
interface AccountsIndex {
  version: number
  /** 当前生效的账号 id；不存在表示"未选择账号"。 */
  activeId?: string
}

/**
 * 一个账号 = 凭证（WebAuth 的全部字段）+ 元信息。
 *
 * 刻意**做成扁平结构**（而不是 `{ meta, auth }` 嵌套）：这样它天然满足 `WebAuth`，
 * `readAuth()` 可以直接把它当凭证返回，适配器/登录流程一行都不用改。
 */
export interface AccountRecord extends WebAuth {
  /** 稳定 id（`acc_` + 8 位十六进制），库内唯一，与 token 无关（token 可能刷新）。 */
  id: string
  /** 用户可改的备注名（如「工作号」）。为空时界面显示掩码账号。 */
  label?: string
  /**
   * 所属分组 id（指向 `groups.json` 里的 `AccountGroup.id`）。
   *
   * 刻意**只存指针、不存组名**：组要能改名与排序，写进每条账号记录就得遍历全库；
   * 而组被删掉时这里会变成"悬挂指针"，`partitionByGroup` 一律按「未分组」处理 ——
   * 所以删组不需要（也不应该）去逐个改账号文件。
   */
  groupId?: string
  /**
   * DeepSeek 服务端的 user id（来自 `users/current` 的 `data.id`）。
   * 用途：**同一账号重复捕获时更新而不是新增**，避免库里堆一堆同一个号。
   */
  serverId?: string
  /** 最近一次主动探活成功的时间（ISO）。见 `src/probe.ts`。 */
  lastVerifiedAt?: string
  /** 最近一次主动探活失败（保留原因，便于一眼看出是过期还是网络问题）。 */
  lastVerifyError?: { at: string; message: string }
  /**
   * 观测到的账号级限制（来自**生成请求被拒**，不是探活）。
   *
   * 更正（2026-09-12 实测）：这里原先写"受限期间 users/current 依然 200，所以探活探不出来" ——
   * 返回 200 是对的，但**响应体里就带着 `chat: { is_muted, mute_until }`**，
   * 也就是说探活其实探得出来，只是目前还没接上。
   * 现在这个状态仍然只从**生成失败**里学到（失败信封里的 mute_until，见 webapi.ts 的 muteUntilMs）。
   */
  limit?: { untilMs: number; observedAt: string; reason?: 'muted' | 'throttled' | 'auth' }
}

const INDEX_VERSION = 1

/** 账号库根目录。多厂商版：每家一个子目录（deepseek 保持旧目录名，零迁移）。 */
export function accountsDir(provider: string = 'deepseek'): string {
  const base = provider === 'deepseek' ? 'accounts' : `accounts-${provider}`
  return join(webLoginDir(), base)
}

export function accountsIndexPath(provider: string = 'deepseek'): string {
  return join(webLoginDir(), provider === 'deepseek' ? 'accounts.json' : `accounts-${provider}.json`)
}

/**
 * 挡住"能跑出账号目录"的 id。
 *
 * ⚠️ F01（2026-09-12 审计）：旧实现直接 `join(accountsDir(), `${id}.json`)`，**没有任何校验**；
 * 而 `importAccounts` 会把**备份文件里的 id 原样当主键**，HTTP 路由也直接吃调用方传的 id。
 * 于是 id 写成 `../../../../Users/me/evil` 就能越界读、写、删账号目录之外的 JSON。
 *
 * 这里只挡"危险字符"而不强求格式：历史 id 形态不止一种（acc_ 前缀 + 8/16 位十六进制、
 * 迁移期还可能有过别的），按白名单收紧会误伤老账号。真正要拦的只有能穿越路径的那些。
 */
/** 单次导入的账号条数上限（N01）：避免一次导入对全库做重复扫描。 */
export const MAX_IMPORT_ACCOUNTS = 500

function assertSafeAccountId(id: string): string {
  const text = String(id ?? '')
  if (!text || text.includes('\0') || text === '.' || text === '..' || /[/\\]/.test(text)) {
    throw new Error(`账号 id 不合法（含路径分隔符或相对路径段）：${JSON.stringify(text)}`)
  }
  return text
}

export function accountFilePath(id: string, provider: string = 'deepseek'): string {
  return join(accountsDir(provider), `${assertSafeAccountId(id)}.json`)
}

/** 新账号 id。用随机 id 而不是 token 哈希：token 会刷新，id 不该跟着变。 */
export function newAccountId(): string {
  return `acc_${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

/** 原子写（临时文件 + 替换），非 Windows 下收紧权限到 0600。 */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  // 临时文件从创建起就是 0600：它装的是**可完整登录的凭证**，
  // 旧写法先按默认权限（受 umask 影响，常见 0644）落地、事后再 chmod，中间有暴露窗口。
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  // ⚠️ F02（2026-09-12 审计）：旧写法是「先 rmSync 目标文件，再 rename 过去」——
  // 一旦 rename 失败（磁盘满 / 占用 / 权限），**原文件已经没了**，凭证直接丢失。
  // 而在 Windows 上 `fs.renameSync` 本来就能直接覆盖已存在的目标文件
  // （实测 win32 + Node 22：renameSync 成功覆盖，目标变新内容，临时文件消失），
  // 所以那句 rmSync 既没必要、也是唯一的丢数据风险点。去掉之后：
  // rename 失败 → 清掉临时文件 → 原文件完好无损。
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {}
    throw error
  }
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600)
    } catch {}
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function readIndex(provider: string = 'deepseek'): AccountsIndex {
  const parsed = readJson<AccountsIndex>(accountsIndexPath(provider))
  return {
    version: INDEX_VERSION,
    ...(typeof parsed?.activeId === 'string' && parsed.activeId ? { activeId: parsed.activeId } : {}),
  }
}

function writeIndex(index: AccountsIndex, provider: string = 'deepseek'): void {
  writeJsonAtomic(accountsIndexPath(provider), { version: INDEX_VERSION, ...(index.activeId ? { activeId: index.activeId } : {}) })
}

/** 把任意对象规整成 AccountRecord（缺字段补默认值；凭证无效返回 undefined）。 */
function normalizeRecord(raw: any, fallbackId?: string): AccountRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const token = typeof raw.token === 'string' ? raw.token : ''
  if (!token) return undefined
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : (fallbackId ?? newAccountId()),
    token,
    cookie: typeof raw.cookie === 'string' ? raw.cookie : '',
    hifDliq: typeof raw.hifDliq === 'string' ? raw.hifDliq : '',
    hifLeim: typeof raw.hifLeim === 'string' ? raw.hifLeim : '',
    wasmUrl: typeof raw.wasmUrl === 'string' ? raw.wasmUrl : '',
    userAgent: typeof raw.userAgent === 'string' ? raw.userAgent : '',
    ...(raw.extraHeaders && typeof raw.extraHeaders === 'object' ? { extraHeaders: raw.extraHeaders } : {}),
    capturedAt: typeof raw.capturedAt === 'string' ? raw.capturedAt : '',
    ...(raw.unverified === true ? { unverified: true } : {}),
    ...(raw.user && typeof raw.user === 'object' ? { user: raw.user } : {}),
    // cookie 过期构成：形状不对的条目在 cookies.ts 里被丢掉，不会让整条记录读不出来
    ...(() => {
      const meta = normalizeCookieMetaList(raw.cookieMeta)
      return meta ? { cookieMeta: meta } : {}
    })(),
    ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {}),
    ...(typeof raw.groupId === 'string' && raw.groupId ? { groupId: raw.groupId } : {}),
    ...(typeof raw.serverId === 'string' && raw.serverId ? { serverId: raw.serverId } : {}),
    ...(typeof raw.lastVerifiedAt === 'string' ? { lastVerifiedAt: raw.lastVerifiedAt } : {}),
    ...(raw.lastVerifyError && typeof raw.lastVerifyError?.at === 'string'
      ? { lastVerifyError: { at: raw.lastVerifyError.at, message: String(raw.lastVerifyError.message ?? '') } }
      : {}),
    ...(raw.limit && Number.isFinite(raw.limit?.untilMs)
      ? { limit: {
          untilMs: Number(raw.limit.untilMs),
          observedAt: String(raw.limit.observedAt ?? ''),
          ...((raw.limit as any).reason ? { reason: (raw.limit as any).reason } : {}),
        } }
      : {}),
  }
}

/** 库内缓存：控制台 10s 轮询 + 轮转器频繁读取，没必要每请求扫盘。写路径全部失效。 */
const listCache = new Map<string, { at: number; records: AccountRecord[] }>()

function invalidateListCache(provider?: string): void {
  if (provider) listCache.delete(provider)
  else listCache.clear()
}

/** 库里全部账号，按捕获时间倒序（最近捕获的在前）。1s 进程内缓存。 */
export function listAccounts(provider: string = 'deepseek'): AccountRecord[] {
  const cached = listCache.get(provider)
  if (cached && Date.now() - cached.at < 1000) return cached.records
  let names: string[] = []
  try {
    names = readdirSync(accountsDir(provider)).filter((name) => name.endsWith('.json') && !name.includes('.tmp-'))
  } catch {
    return []
  }
  const records: AccountRecord[] = []
  for (const name of names) {
    const id = name.replace(/\.json$/, '')
    const record = normalizeRecord(readJson(accountFilePath(id, provider)), id)
    if (record) records.push(record)
  }
  records.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
  listCache.set(provider, { at: Date.now(), records })
  return records
}

export function readAccount(id: string, provider: string = 'deepseek'): AccountRecord | undefined {
  if (!id) return undefined
  return normalizeRecord(readJson(accountFilePath(id, provider)), id)
}

export function saveAccount(record: AccountRecord, provider: string = 'deepseek'): void {
  writeJsonAtomic(accountFilePath(record.id, provider), record)
  listCache.delete(provider)
}

export function activeAccountId(provider: string = 'deepseek'): string | undefined {
  const { activeId } = readIndex(provider)
  if (!activeId) return undefined
  // 索引指向的账号可能已被移除 —— 那就当"未选择"，不要让调用方拿到悬空 id。
  // 也可能 id 本身不合法（索引文件被外部改过）→ 同理当"未选择"，而不是让异常炸穿调用方。
  try {
    return existsSync(accountFilePath(activeId, provider)) ? activeId : undefined
  } catch {
    return undefined
  }
}

/** 当前生效的账号（没有就返回 undefined）。 */
export function activeAccount(provider: string = 'deepseek'): AccountRecord | undefined {
  const id = activeAccountId(provider)
  return id ? readAccount(id, provider) : undefined
}

export function setActiveAccount(id: string, provider: string = 'deepseek'): boolean {
  if (!existsSync(accountFilePath(id, provider))) return false
  writeIndex({ version: 1, activeId: id }, provider)
  return true
}

export function clearActiveAccount(provider: string = 'deepseek'): void {
  writeIndex({ version: 1 }, provider)
}

export function updateAccount(id: string, patch: Partial<AccountRecord>, provider: string = 'deepseek'): AccountRecord | undefined {
  const current = readAccount(id, provider)
  if (!current) return undefined
  const next = normalizeRecord({ ...current, ...patch, id }, id)
  if (!next) return undefined
  saveAccount(next, provider)
  return next
}

/**
 * 从账号库里移除一个账号（**删除凭证文件**）。
 *
 * 为什么不学其它可逆操作"改名留档"：这里存的是**可完整登录的凭证**，
 * 「退出/移除」的语义就是"这份凭证不该再留在磁盘上" ——
 * 留一个 `.removed-<时间>` 的明文备份会让"已登出"变成谎话（安全上的倒退）。
 * 误删的保护交给两件事：界面上**二次确认**，以及账号库**导出备份**。
 */
export function removeAccount(id: string, provider: string = 'deepseek'): boolean {
  const file = accountFilePath(id, provider)
  if (!existsSync(file)) return false
  try {
    rmSync(file, { force: true })
  } catch {
    return false
  }
  listCache.delete(provider)
  if (readIndex(provider).activeId === id) clearActiveAccount(provider)
  return true
}

/**
 * 写入/更新一个账号的凭证（登录捕获、手动粘贴 token 都走这里）。
 *
 * 去重顺序：
 *  1. 有 `serverId` 且库里已有同 `serverId` → **更新那一条**（同一账号重新捕获）；
 *  2. 否则 token 完全相同的记录 → 更新（serverId 还没拿到的场景）；
 *  3. 都没有 → 新增。
 *
 * ⚠️ **凭证字段一律以本次传入的为准，不做合并**：调用方（例如登录流程）用
 * `writeAuth({ ...auth, unverified: true })` 表示"这次没校验成功"，
 * 若沿用旧记录的字段，这条 `unverified` 会永远粘住、再也清不掉。
 * 需要跨次保留的只有元信息（备注名/探活时间/限制状态），所以只挑那几个字段继承。
 */
export function upsertAccount(auth: WebAuth, patch: Partial<AccountRecord> = {}, provider: string = 'deepseek'): AccountRecord {
  // serverId 可能随 `patch` 传，也可能被调用方直接塞进 `auth` 里（登录流程习惯写
  // `writeAuth({ ...auth, user })`）—— 两种都得认，否则去重会静默失效、库里堆重复条目。
  const incoming = auth as Partial<AccountRecord>
  const serverId = patch.serverId ?? incoming.serverId

  const all = listAccounts(provider)
  const existing =
    (serverId ? all.find((item) => item.serverId && item.serverId === serverId) : undefined) ??
    // 兼容旧记录（审计 F04）：`serverId` 是后加的字段，老库里可能只存了 `user.id`。
    // 只认**没有 serverId** 的记录，免得跟上面那条抢匹配（那条才是权威身份键）。
    (serverId ? all.find((item) => !item.serverId && item.user?.id === serverId) : undefined) ??
    all.find((item) => item.token === auth.token)
  const id = patch.id ?? existing?.id ?? newAccountId()

  const carried: Partial<AccountRecord> = {}
  // ⚠️ 这个白名单决定「重新登录 / 导入」时哪些**用户附加的元数据**会被带过去。
  // 少了 groupId 就会出现"重登一次，账号从组里掉出来"这种很难查的 bug。
  for (const key of ['label', 'groupId', 'serverId', 'lastVerifiedAt', 'lastVerifyError', 'limit'] as const) {
    const value = (patch as any)[key] ?? (incoming as any)[key] ?? (existing as any)?.[key]
    if (value !== undefined) (carried as any)[key] = value
  }

  // ⚠️ `user` 必须单独做**深合并**，不能塞进上面那个 `??` 链里 ——
  // 它是服务端在**校验通过**时才给的「一次性」信息，而重登 / 导入时新凭证往往还是
  // `unverified`（拿不到 user）。若按"新值整体覆盖"处理，就会把原记录里可辨识的显示名抹成空：
  // 界面上的账号从「137******78」退化成「未识别账号 (acc_xxxx)」—— 2026-09-17 实测，
  // 用户看到的现象是"发个消息账号就退出了"。而 `serverId` 还在，说明这条记录本来是有身份的。
  // 这里按字段合并、新值优先、缺的字段沿用旧值。
  const userFromPatch = (patch as any)?.user
  const userFromIncoming = (incoming as any)?.user
  const mergedUser = {
    ...(existing?.user ?? {}),
    ...(userFromIncoming && typeof userFromIncoming === 'object' ? userFromIncoming : {}),
    ...(userFromPatch && typeof userFromPatch === 'object' ? userFromPatch : {}),
  }
  if (Object.keys(mergedUser).length > 0) carried.user = mergedUser as AccountRecord['user']

  const record = normalizeRecord({ ...auth, ...carried, id }, id)!
  saveAccount(record, provider)
  return record
}

/**
 * 打包一份导出数据（含明文凭证 —— 调用方必须把风险讲给用户）。
 *
 * ⚠️ 这条数据现在有两条出口，安全姿态不同：
 *   1. `exportAccountsToFile()` + `POST /accounts/export`：**凭证不出宿主**，
 *      宿主自己写盘、只回传路径。始终保留，是回退路径。
 *   2. `POST /accounts/export-json`：把内容交给界面，由界面弹系统「另存为」写盘。
 *      为了让用户能自己选保存位置，这条路躲不开（理由见 index.ts 里那个路由的注释）。
 */
export function exportAccounts(): { version: number; exportedAt: string; warning: string; accounts: AccountRecord[] } {
  return {
    version: INDEX_VERSION,
    exportedAt: new Date().toISOString(),
    warning: '此文件含可完整登录的凭证（token + cookie），等同于账号本身，请勿分享或提交到仓库',
    accounts: listAccounts(),
  }
}

/**
 * 导出到**插件目录下的文件**并返回路径（`<web-login>/exports/accounts-<时间戳>.json`）。
 *
 * 这是回退路径：界面拿不到系统「另存为」（宿主未注入 File System Access、
 * 或弹框被平台拒绝）时用它，保证导出功能永不失效。
 * 优点是明文凭证不进 HTTP 响应体，只把**路径**回给界面。
 */
export function exportAccountsToFile(): { path: string; count: number } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(webLoginDir(), 'exports', `accounts-${stamp}.json`)
  writeJsonAtomic(file, exportAccounts())
  return { path: file, count: listAccounts().length }
}

/**
 * 导入（校验 + 去重 + 补 id）。返回新增/更新数量。
 *
 * ⚠️ **绝不相信备份文件自报的 `id`**（2026-09-13 第二轮审计 N01）：
 * 旧实现用 `normalizeRecord(raw)` 时**不传 fallbackId 根本不生效** ——
 * `normalizeRecord` 内部仍是 `raw.id ?? fallbackId ?? newAccountId()`，
 * 于是备份里写同一个 `id` 的两条不同 token 账号会**互相覆盖**（不需要路径穿越）。
 * 现在导入一律**生成本地主键**，只有 token 命中才允许更新已有账号。
 *
 * `serverId` 同样不用于匹配：它是**备份自报**字段，不能拿它授权覆盖不同 token 的账号。
 * 代价：同账号刷新 token 的备份会多出一条，需要用户手动确认合并 —— 但保护了旧凭证。
 *
 * 上限 500 条，避免一次导入触发对全库的重复扫描；整批非事务，中途磁盘失败可能部分导入。
 */
export function importAccounts(payload: unknown): { imported: number; updated: number; skipped: number } {
  const list = Array.isArray(payload) ? payload : (payload as any)?.accounts
  if (!Array.isArray(list)) return { imported: 0, updated: 0, skipped: 0 }
  if (list.length > MAX_IMPORT_ACCOUNTS) throw new RangeError(`每批最多导入 ${MAX_IMPORT_ACCOUNTS} 个账号`)
  const records = listAccounts()
  const ids = new Set(records.map((r) => r.id))
  const tokens = new Map(records.map((r) => [r.token, r]))
  let imported = 0
  let updated = 0
  let skipped = 0
  for (const raw of list) {
    const candidate = normalizeRecord(raw)
    if (!candidate) {
      skipped += 1
      continue
    }
    const matched = tokens.get(candidate.token)
    let record: AccountRecord
    if (matched) {
      // 保留本地元信息（备注名、探活、限制状态），只替换凭证
      record = { ...matched, ...candidate, id: matched.id, label: candidate.label ?? matched.label }
      updated += 1
    } else {
      let id: string
      do {
        id = newAccountId()
      } while (ids.has(id))
      ids.add(id)
      record = { ...candidate, id }
      imported += 1
    }
    saveAccount(record)
    tokens.set(record.token, record)
  }
  // 一个账号都没有时，把导入进来的第一个设为当前（否则导入了却"未选择账号"，很莫名其妙）
  if (!activeAccountId()) {
    const first = listAccounts()[0]
    if (first) setActiveAccount(first.id)
  }
  return { imported, updated, skipped }
}

/**
 * 迁移指针：最近一次迁移是否**完整**完成（失败原因留给调用方记日志）。
 *
 * 为什么需要它（审计 F21）：以前迁移把旧文件 `rename` 成 `.migrated-<时间戳>` **留档**，
 * 于是"退出登录"删掉的是账号库里的记录，而那份**明文旧凭证**还躺在磁盘上、照样能登录 ——
 * "已登出"就成了一句谎话。现在成功迁移后**删掉源文件**，失败必须能被看见，不能静默。
 */
let lastMigrationError: string | undefined

/** 最近一次迁移的失败原因（undefined = 没有失败）。 */
export function legacyMigrationError(): string | undefined {
  return lastMigrationError
}

/**
 * 一次性迁移：把 0.1.25 及以前的单账号文件搬进账号库。
 *
 * 旧文件在**确认新记录已落盘**之后被删除（不再留 `.migrated-*` 明文副本）。
 * 返回迁移出的账号（没有则 undefined）；写入校验失败会抛错，由调用方记录。
 */
export function migrateLegacyAuth(): AccountRecord | undefined {
  const legacy = legacyAuthFilePath()
  const record = normalizeRecord(readJson(legacy))
  if (!record) return undefined
  // 已经在库里（同 token）就不重复导入
  const existing = listAccounts().find((item) => item.token === record.token)
  const saved = existing ?? { ...record, id: newAccountId() }
  if (!existing) saveAccount(saved)
  // 先确认这次迁移真的落盘了，再删源文件 —— 顺序反了就会丢凭证
  const verified = readAccount(saved.id)
  if (!verified || verified.token !== record.token) {
    throw new Error('迁移写入验证失败：账号库里的记录与旧凭证不一致')
  }
  rmSync(legacy)
  lastMigrationError = undefined
  if (!activeAccountId()) setActiveAccount(saved.id)
  return saved
}

/** 迁移只在"库为空 且 旧文件在"时跑一次。 */
export function migrateLegacyAuthIfNeeded(): AccountRecord | undefined {
  try {
    if (listAccounts().length > 0) return undefined
    if (!existsSync(legacyAuthFilePath())) return undefined
    return migrateLegacyAuth()
  } catch (error: any) {
    // 不静默：旧凭证可能还在磁盘上，调用方要把这句记进日志/界面
    lastMigrationError = `旧凭证未清除，迁移未完整完成：${error?.message ?? error}`
    return undefined
  }
}


/** 账号展示名：备注名优先，其次掩码账号，再次 id。 */
export function accountTitle(record: AccountRecord, mask: (raw: string) => string): string {
  if (record.label) return record.label
  const display = record.user?.display || record.user?.id || ''
  // 一个名字都没拿到时（刚捕获、还没校验过），别把**内部 id**（`acc_cd8e05ec`）当名字摆出来 ——
  // 用户看到一串 hex 只会以为是 bug（实测反馈）。写明"未识别"，并留一小截后缀，
  // 这样多个未识别账号之间还能区分。
  if (!display) return `未识别账号（${record.id.replace(/^acc_/, '').slice(0, 8)}）`
  return mask(display)
}

/** 库文件体积（供界面提示"账号库占用"，也便于发现异常膨胀）。 */
export function accountsFootprint(): { count: number; bytes: number } {
  let bytes = 0
  let count = 0
  try {
    for (const name of readdirSync(accountsDir())) {
      if (!name.endsWith('.json') || name.includes('.tmp-')) continue
      count += 1
      try {
        bytes += statSync(join(accountsDir(), name)).size
      } catch {}
    }
  } catch {}
  return { count, bytes }
}
