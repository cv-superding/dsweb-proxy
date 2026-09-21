/**
 * 账号分组：组定义落盘 + 列表按组分区（按 provider 分区存储）。
 *
 * 为什么单独一个文件而不是把组名写进账号记录：
 *  1. 组要能改名 —— 写进账号记录就得遍历全库；
 *  2. 组要能排序 —— 否则组之间照样乱；
 *  3. 账号记录里只留 `groupId` 指针 ⇒ 删组不会误删账号（悬挂指针一律按「未分组」处理）。
 *
 * 多厂商：deepseek 沿用旧文件名 `groups.json`（零迁移），其余为 `groups-<provider>.json`。
 * 分组**只影响显示** —— 切号、轮转、节流都不感知组。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { webLoginDir } from './paths.ts'

export interface AccountGroup {
  id: string
  name: string
  /** 组之间的显示顺序（越小越靠前）。当前账号所在组会被置顶，见 partitionByGroup。 */
  order: number
}

/** 分区结果。`key` 可直接当渲染 key 用（`__ungrouped__` 表示未分组）。 */
export interface GroupSection<T> {
  key: string
  name: string
  /** null = 未分组。 */
  groupId: string | null
  accounts: T[]
}

export const UNGROUPED_KEY = '__ungrouped__'
export const UNGROUPED_NAME = '未分组'

export const MAX_GROUP_NAME = 20
export const MAX_GROUPS = 12

export function groupsFilePath(provider: string = 'deepseek'): string {
  return join(webLoginDir(), provider === 'deepseek' ? 'groups.json' : `groups-${provider}.json`)
}

/** 规整组名：去首尾空白、折空白、去控制字符、截断到上限。 */
export function normalizeGroupName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_GROUP_NAME)
}

/** 读盘容错：只收形状正确的条目，坏数据不会让整张表读不出来。 */
export function normalizeGroupList(raw: unknown): AccountGroup[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: AccountGroup[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = typeof (item as any).id === 'string' ? (item as any).id.trim() : ''
    const name = normalizeGroupName((item as any).name)
    if (!id || !name || seen.has(id)) continue
    const orderRaw = (item as any).order
    const order = Number.isFinite(orderRaw) ? Number(orderRaw) : out.length
    seen.add(id)
    out.push({ id, name, order })
  }
  out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  return out.slice(0, MAX_GROUPS).map((group, index) => ({ ...group, order: index }))
}

export function readGroups(provider: string = 'deepseek'): AccountGroup[] {
  try {
    const file = groupsFilePath(provider)
    if (!existsSync(file)) return []
    return normalizeGroupList(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

export function writeGroups(list: AccountGroup[], provider: string = 'deepseek'): void {
  const file = groupsFilePath(provider)
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(normalizeGroupList(list), null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清不掉就算了 */
    }
    throw error
  }
}

export function newGroupId(taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let i = 0; i < 32; i += 1) {
    const id = `g_${randomBytes(4).toString('hex')}`
    if (!used.has(id)) return id
  }
  return `g_${randomBytes(6).toString('hex')}`
}

/** 新建组。名字空 / 重名 / 超上限时返回 error（不改动 list）。 */
export function createGroup(
  list: AccountGroup[],
  rawName: unknown,
): { list: AccountGroup[]; group?: AccountGroup; error?: string } {
  const current = normalizeGroupList(list)
  const name = normalizeGroupName(rawName)
  if (!name) return { list: current, error: '组名不能为空' }
  if (current.length >= MAX_GROUPS) return { list: current, error: `最多 ${MAX_GROUPS} 个组` }
  if (current.some((group) => group.name === name)) return { list: current, error: `已经有一个叫「${name}」的组了` }
  const group: AccountGroup = { id: newGroupId(current.map((item) => item.id)), name, order: current.length }
  return { list: [...current, group], group }
}

export function renameGroup(
  list: AccountGroup[],
  id: string,
  rawName: unknown,
): { list: AccountGroup[]; error?: string } {
  const current = normalizeGroupList(list)
  const name = normalizeGroupName(rawName)
  if (!name) return { list: current, error: '组名不能为空' }
  if (!current.some((group) => group.id === id)) return { list: current, error: '组不存在' }
  if (current.some((group) => group.id !== id && group.name === name)) {
    return { list: current, error: `已经有一个叫「${name}」的组了` }
  }
  return { list: current.map((group) => (group.id === id ? { ...group, name } : group)) }
}

/** 删除组定义（**只删组、不删账号**：账号记录里的 groupId 变成悬挂指针 → 归「未分组」）。 */
export function removeGroup(list: AccountGroup[], id: string): AccountGroup[] {
  const current = normalizeGroupList(list)
  const kept = current.filter((group) => group.id !== id)
  return kept.map((group, index) => ({ ...group, order: index }))
}

export interface GroupableAccount {
  id: string
  groupId?: string
}

/**
 * 把账号切成「按组分区」的若干段。
 *  1. 当前账号所在组置顶；2. 其余组按 order；3. 未分组垫底（含指向已删组的悬挂指针）。
 * 空组照样返回（新建完要能立刻看见）；未分组为空时不返回。
 */
export function partitionByGroup<T extends GroupableAccount>(
  accounts: T[],
  groups: AccountGroup[],
  activeId: string | null | undefined,
): GroupSection<T>[] {
  const normalized = normalizeGroupList(groups)
  const known = new Set(normalized.map((group) => group.id))
  const buckets = new Map<string, T[]>()
  const ungrouped: T[] = []
  for (const account of accounts) {
    const gid = account.groupId && known.has(account.groupId) ? account.groupId : ''
    if (!gid) {
      ungrouped.push(account)
      continue
    }
    const bucket = buckets.get(gid)
    if (bucket) bucket.push(account)
    else buckets.set(gid, [account])
  }

  const activeGroupId = accounts.find((account) => account.id === activeId)?.groupId ?? ''
  const pinned = activeGroupId && known.has(activeGroupId) ? activeGroupId : ''

  const sections: GroupSection<T>[] = []
  const ordered = pinned
    ? [...normalized.filter((group) => group.id === pinned), ...normalized.filter((group) => group.id !== pinned)]
    : normalized
  for (const group of ordered) {
    sections.push({ key: group.id, name: group.name, groupId: group.id, accounts: buckets.get(group.id) ?? [] })
  }
  if (ungrouped.length) {
    sections.push({ key: UNGROUPED_KEY, name: UNGROUPED_NAME, groupId: null, accounts: ungrouped })
  }
  return sections
}
