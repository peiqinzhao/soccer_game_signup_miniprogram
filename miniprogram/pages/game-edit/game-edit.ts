import { run } from '../../utils/api'
import { setFlash } from '../../utils/flash'
import { fmtDate, TIMEZONES, deviceTimeZone, formatText, teamsRuleText } from '../../utils/format'
import { ClubSettings, GameForm, GameTemplate, Venue } from '../../utils/types'

const DURATIONS = [60, 90, 120]
const DAY = 24 * 3600 * 1000
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

// 'YYYY-MM-DD' 按本地日期解析（中午，避开夏令时切换）
const parseDate = (d: string) => new Date(`${d}T12:00:00`)

function tomorrow(): string {
  return fmtDate(Date.now() + DAY)
}

// 明天起第一个星期 weekday 的日期
function nextWeekday(weekday: number): string {
  const d = parseDate(tomorrow())
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1)
  return fmtDate(d.getTime())
}

function splitTags(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

// 定时开放报名的默认值：比赛前 3 天 20:00（周日的比赛 → 周四 20:00）
const SIGNUP_OPEN_DAYS_BEFORE = 3
const SIGNUP_OPEN_TIME = '20:00'
function defaultSignupOpens(date: string) {
  const open = { date: fmtDate(parseDate(date).getTime() - SIGNUP_OPEN_DAYS_BEFORE * DAY), time: SIGNUP_OPEN_TIME }
  return { ...open, future: new Date(`${open.date}T${open.time}:00`).getTime() > Date.now() }
}

// 按球队设置算默认截止：比赛前 N 天的固定时刻
function defaultDeadline(date: string, s: ClubSettings) {
  return { date: fmtDate(parseDate(date).getTime() - s.cancelDeadlineDaysBefore * DAY), time: s.cancelDeadlineTime }
}

function tzIndexOf(tz: string): number {
  let i = TIMEZONES.findIndex((t) => t.id === tz)
  if (i < 0) {
    TIMEZONES.push({ id: tz, label: tz })
    i = TIMEZONES.length - 1
  }
  return i
}

Page({
  data: {
    clubId: '',
    gameId: '',
    ready: false,
    copied: false,
    venues: [] as Venue[],
    venueIndex: -1,
    templates: [] as GameTemplate[],
    tzLabels: TIMEZONES.map((t) => t.label),
    tzIndex: 0,
    durations: DURATIONS,
    today: fmtDate(Date.now()),
    title: '',
    note: '',
    date: '',
    time: '10:00',
    durationMin: 120,
    capacity: '24',
    // 赛制与分队
    teamSize: 8,
    teamCount: 3,
    sizeOptions: [5, 7, 8],
    countOptions: [2, 3],
    formatText: '8v8v8',
    autoTeams: false,
    goalkeeper: false,
    teamsRule: '',
    tagsText: '', // 可选标签，逗号或空格分隔
    lateGraceMin: '10',
    fineDollars: '5',
    scheduled: false,
    signupDate: '',
    signupTime: '20:00',
    signupEdited: false, // 手动改过开放时间后，改比赛日期时不再自动跟随
    scheduledTouched: false, // 手动开关过“定时开放报名”后，不再自动开关
    deadlineDate: '',
    deadlineTime: '21:00',
    deadlineEdited: false, // 手动改过后，改比赛日期时不再自动跟随
    settings: null as ClubSettings | null,
  },

  async onLoad(q: Record<string, string | undefined>) {
    const clubId = q.clubId || ''
    const gameId = q.gameId || ''
    this.setData({ clubId, gameId })
    if (gameId) wx.setNavigationBarTitle({ title: '编辑比赛' })
    await this.loadForm(!gameId)
  },

  onShow() {
    // 从“添加场地”页返回时刷新场地列表
    if (this.data.ready) this.refreshVenues()
  },

  async loadForm(copyLast: boolean) {
    const res = await run<{ form: GameForm | null; venues: Venue[]; settings: ClubSettings; templates: GameTemplate[] }>(
      'gameForm',
      { clubId: this.data.clubId, gameId: this.data.gameId, copyLast },
    )
    if (!res) return
    const s = res.settings
    const f = res.form
    const devTz = deviceTimeZone()
    const tz = f ? f.timezone : TIMEZONES.some((t) => t.id === devTz) ? devTz : s.timezone
    const tzIndex = tzIndexOf(tz)
    this.setData({
      ready: true,
      copied: !!f && !this.data.gameId,
      settings: s,
      templates: res.templates || [],
      venues: res.venues,
      venueIndex: f ? res.venues.findIndex((v) => v._id === f.venueId) : res.venues.length === 1 ? 0 : -1,
      tzLabels: TIMEZONES.map((t) => t.label),
      tzIndex,
      title: f ? f.title : '',
      note: f ? f.note : '',
      date: f ? f.date : tomorrow(),
      time: f ? f.time : '10:00',
      durationMin: f ? f.durationMin : s.durationMin,
      capacity: String(f ? f.capacity : s.capacity),
      teamSize: f ? f.teamSize : 8,
      teamCount: f ? f.teamCount : 3,
      autoTeams: !!(f && f.autoTeams),
      goalkeeper: !!(f && f.goalkeeper),
      // 新比赛：优先球队默认标签，没设就沿用复制来的上一场；编辑已有比赛用它自己的
      tagsText: (!this.data.gameId && s.defaultTags && s.defaultTags.length ? s.defaultTags : (f && f.tags) || []).join('，'),
      lateGraceMin: String(f ? f.lateGraceMin : s.lateGraceMin),
      fineDollars: String((f ? f.fineCents : s.fineCents) / 100),
    })
    // 定时开放报名：新比赛默认开启（比赛前 3 天 20:00，已过则不开启）；编辑/复制时沿用原设置
    const defOpen = defaultSignupOpens(this.data.date)
    const open = f && f.signupOpens
    this.setData({
      scheduled: f ? !!open : defOpen.future,
      signupDate: open ? open.date : defOpen.date,
      signupTime: open ? open.time : defOpen.time,
      signupEdited: !!open && (open.date !== defOpen.date || open.time !== defOpen.time),
      scheduledTouched: !!f,
    })
    this.updateFormat()
    // 编辑已有比赛时用它自己的截止时间；和默认值一样就当作没改过
    const def = defaultDeadline(this.data.date, s)
    const cur = f && f.cancelDeadline ? f.cancelDeadline : def
    this.setData({
      deadlineDate: cur.date,
      deadlineTime: cur.time,
      deadlineEdited: cur.date !== def.date || cur.time !== def.time,
    })
  },

  async refreshVenues() {
    const res = await run<{ venues: Venue[] }>('getClub', { clubId: this.data.clubId }, '')
    if (!res) return
    const cur = this.data.venues[this.data.venueIndex]
    const idx = cur ? res.venues.findIndex((v) => v._id === cur._id) : res.venues.length === 1 ? 0 : -1
    this.setData({ venues: res.venues, venueIndex: idx })
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  onPick(e: WechatMiniprogram.PickerChange) {
    const key = e.currentTarget.dataset.key as string
    const v = e.detail.value
    this.setData({ [key]: key.endsWith('Index') ? Number(v) : v })
    if (key === 'deadlineDate' || key === 'deadlineTime') this.setData({ deadlineEdited: true })
    if (key === 'signupDate' || key === 'signupTime') this.setData({ signupEdited: true })
    if (key === 'date') {
      this.syncDeadline()
      this.syncSignupOpens()
    }
  },

  syncSignupOpens() {
    if (this.data.signupEdited) return
    const def = defaultSignupOpens(this.data.date)
    const patch: Record<string, unknown> = { signupDate: def.date, signupTime: def.time }
    if (!this.data.scheduledTouched) patch.scheduled = def.future
    this.setData(patch)
  },

  syncDeadline() {
    if (this.data.deadlineEdited || !this.data.settings) return
    const def = defaultDeadline(this.data.date, this.data.settings)
    this.setData({ deadlineDate: def.date, deadlineTime: def.time })
  },

  onSwitch(e: WechatMiniprogram.SwitchChange) {
    const key = e.currentTarget.dataset.key
    this.setData({ [key]: e.detail.value })
    if (key === 'autoTeams' && !e.detail.value) this.setData({ goalkeeper: false })
    if (key === 'scheduled') this.setData({ scheduledTouched: true })
  },

  // ---------- 赛制 ----------

  updateFormat() {
    const { teamSize, teamCount } = this.data
    this.setData({ formatText: formatText(teamSize, teamCount), teamsRule: teamsRuleText(teamSize, teamCount) })
  },

  async pickFormat(e: WechatMiniprogram.TouchEvent) {
    const key: 'teamSize' | 'teamCount' = e.currentTarget.dataset.key
    let v = Number(e.currentTarget.dataset.v)
    if (!v) {
      const [lo, hi] = key === 'teamSize' ? [2, 20] : [2, 6]
      const r = await wx.showModal({ title: key === 'teamSize' ? '每队人数' : '队数', content: '', editable: true, placeholderText: `${lo}–${hi}` })
      v = Math.round(Number(r.content))
      if (!r.confirm) return
      if (!(v >= lo && v <= hi)) {
        wx.showToast({ title: `需在 ${lo}–${hi} 之间`, icon: 'none' })
        return
      }
    }
    this.setData({ [key]: v })
    // 人数上限跟着赛制走
    this.setData({ capacity: String(this.data.teamSize * this.data.teamCount) })
    this.updateFormat()
  },

  pickDuration(e: WechatMiniprogram.TouchEvent) {
    this.setData({ durationMin: Number(e.currentTarget.dataset.v) })
  },

  addVenue() {
    wx.navigateTo({ url: `/pages/venue/venue?clubId=${this.data.clubId}` })
  },

  // ---------- 模板 ----------

  async importTemplate() {
    const list = this.data.templates
    if (!list.length) {
      wx.showModal({ title: '还没有模板', content: '填好表单后点底部的“保存为模板”即可。', showCancel: false })
      return
    }
    const items = [...list.map((t) => t.name), '删除模板…']
    let tap: number
    try {
      tap = (await wx.showActionSheet({ itemList: items })).tapIndex
    } catch (e) {
      return
    }
    if (tap === list.length) {
      this.deleteTemplate()
      return
    }
    this.applyTemplate(list[tap])
  },

  applyTemplate(t: GameTemplate) {
    const date = nextWeekday(t.weekday)
    const venueIndex = this.data.venues.findIndex((v) => v._id === t.venueId)
    this.setData({
      copied: false,
      title: t.title,
      note: t.note,
      tzLabels: TIMEZONES.map((x) => x.label),
      tzIndex: tzIndexOf(t.timezone),
      date,
      time: t.time,
      durationMin: t.durationMin,
      venueIndex,
      capacity: String(t.capacity),
      teamSize: t.teamSize || 8,
      teamCount: t.teamCount || 3,
      autoTeams: !!t.autoTeams,
      goalkeeper: !!t.goalkeeper,
      tagsText: (t.tags || []).join('，'),
      lateGraceMin: String(t.lateGraceMin),
      fineDollars: String(t.fineCents / 100),
      scheduled: !!t.signupOpens,
      scheduledTouched: true,
      signupEdited: !!t.signupOpens,
      signupDate: t.signupOpens ? fmtDate(parseDate(date).getTime() - t.signupOpens.daysBefore * DAY) : this.data.signupDate,
      signupTime: t.signupOpens ? t.signupOpens.time : this.data.signupTime,
      deadlineEdited: false,
    })
    this.syncDeadline()
    this.updateFormat()
    wx.showToast({ title: venueIndex < 0 ? '模板的场地已删除，请重新选择' : `已导入“${t.name}”`, icon: 'none' })
  },

  async deleteTemplate() {
    const list = this.data.templates
    let tap: number
    try {
      tap = (await wx.showActionSheet({ itemList: list.map((t) => `删除“${t.name}”`), itemColor: '#d4380d' })).tapIndex
    } catch (e) {
      return
    }
    const res = await run<{ templates: GameTemplate[] }>(
      'deleteTemplate',
      { clubId: this.data.clubId, templateId: list[tap].id },
      '删除中',
    )
    if (res) this.setData({ templates: res.templates })
  },

  async saveAsTemplate() {
    const d = this.data
    const venue = d.venues[d.venueIndex]
    if (!venue) {
      wx.showToast({ title: '请先选择场地', icon: 'none' })
      return
    }
    const weekday = parseDate(d.date).getDay()
    const r = await wx.showModal({
      title: '保存为模板',
      content: `${venue.name} 周${WEEK[weekday]}`,
      editable: true,
      placeholderText: '模板名称',
    })
    const name = (r.content || '').trim()
    if (!r.confirm || !name) return
    const daysBefore = Math.round((parseDate(d.date).getTime() - parseDate(d.signupDate).getTime()) / DAY)
    const template = {
      name,
      title: d.title,
      note: d.note,
      timezone: TIMEZONES[d.tzIndex].id,
      weekday,
      time: d.time,
      durationMin: d.durationMin,
      venueId: venue._id,
      capacity: Number(d.capacity),
      teamSize: d.teamSize,
      teamCount: d.teamCount,
      autoTeams: d.autoTeams,
      goalkeeper: d.autoTeams && d.goalkeeper,
      tags: splitTags(d.tagsText),
      lateGraceMin: Number(d.lateGraceMin),
      fineCents: Math.round(Number(d.fineDollars) * 100),
      signupOpens: d.scheduled ? { daysBefore, time: d.signupTime } : null,
    }
    const res = await run<{ templates: GameTemplate[] }>('saveTemplate', { clubId: d.clubId, template }, '保存中')
    if (!res) return
    this.setData({ templates: res.templates })
    wx.showToast({ title: '模板已保存', icon: 'success' })
  },

  // ---------- 提交 ----------

  async save() {
    const d = this.data
    const venue = d.venues[d.venueIndex]
    if (!venue) {
      wx.showToast({ title: '请选择场地', icon: 'none' })
      return
    }
    const form: GameForm = {
      title: d.title,
      note: d.note,
      timezone: TIMEZONES[d.tzIndex].id,
      date: d.date,
      time: d.time,
      durationMin: d.durationMin,
      venueId: venue._id,
      capacity: Number(d.capacity),
      teamSize: d.teamSize,
      teamCount: d.teamCount,
      autoTeams: d.autoTeams,
      goalkeeper: d.autoTeams && d.goalkeeper,
      tags: splitTags(d.tagsText),
      lateGraceMin: Number(d.lateGraceMin),
      fineCents: Math.round(Number(d.fineDollars) * 100),
      signupOpens: d.scheduled ? { date: d.signupDate, time: d.signupTime } : null,
      // 没改过就交给服务端按球队设置计算（和比赛时区一致）
      cancelDeadline: d.deadlineEdited ? { date: d.deadlineDate, time: d.deadlineTime } : null,
    }
    const res = await run<{ gameId: string; changed?: boolean; notified?: number }>(
      'saveGame',
      { clubId: d.clubId, gameId: d.gameId, form },
      '保存中',
    )
    if (!res) return
    if (d.gameId) {
      if (res.changed) setFlash('gameChanged', { gameId: d.gameId, notified: res.notified || 0 })
      wx.navigateBack()
    } else {
      wx.redirectTo({ url: `/pages/game/game?id=${res.gameId}` })
    }
  },
})
