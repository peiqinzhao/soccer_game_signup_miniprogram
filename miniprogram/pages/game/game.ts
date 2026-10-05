import { call, run, toastError } from '../../utils/api'
import { getSession, needsProfile } from '../../utils/session'
import { fmtTime, fmtTimeSec, fmtShort, money, gameTimeText, ATTENDANCE_TEXT, formatText } from '../../utils/format'
import { GameDetail, GameFine, RegView } from '../../utils/types'
import { PROMOTED_TEMPLATE_ID, CHANGED_TEMPLATE_ID, OPEN_TEMPLATE_ID } from '../../config'
import { takeFlash } from '../../utils/flash'

const MIN = 60 * 1000

interface Row extends RegView {
  badge: string
  badgeClass: string
  timeText: string
  fineText: string // 管理员可见：本场罚款状态
  fineClass: string
  pendingFineIds: string[]
  pendingFineText: string
}

const FINE_STATUS: Record<string, string> = { pending: '待付', paid: '已付', waived: '已豁免' }

function fineInfo(fines: GameFine[]) {
  if (!fines.length) return { fineText: '', fineClass: '', pendingFineIds: [], pendingFineText: '' }
  const pending = fines.filter((f) => f.status === 'pending')
  const shown = pending.length ? pending : fines
  const cents = shown.reduce((s, f) => s + f.amountCents, 0)
  const status = pending.length ? 'pending' : shown[shown.length - 1].status
  return {
    fineText: `罚款${money(cents)} ${FINE_STATUS[status]}`,
    fineClass: status === 'pending' ? 'tag-bad' : '',
    pendingFineIds: pending.map((f) => f._id),
    pendingFineText: pending.map((f) => `${f.reasonText} ${money(f.amountCents)}`).join('、'),
  }
}

type Phase = 'free' | 'warn' | 'penalty'

// 请求订阅消息授权；必须在点击事件里第一时间调用。返回每个模板是否同意
async function askSubscribe(ids: string[]): Promise<Record<string, boolean>> {
  const tmplIds = ids.filter(Boolean)
  const out: Record<string, boolean> = {}
  if (!tmplIds.length) return out
  try {
    const r = (await wx.requestSubscribeMessage({ tmplIds } as any)) as any
    for (const id of tmplIds) out[id] = r[id] === 'accept'
  } catch (e) {
    // 用户关闭了订阅开关等，忽略
  }
  return out
}

// 当前运行的版本（develop / trial / release），通知点开后回到同一版本
function envVersion(): string {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion
  } catch (e) {
    return 'release'
  }
}

// 例：通知：变更 18/24 · 替补 3/5 · 开放提醒 12 人待发
function notifyText(d: GameDetail, t: number): string {
  const n = d.notifyStats
  if (!n) return ''
  const parts = [`变更 ${n.change}/${n.active}`]
  if (n.waitlist) parts.push(`替补 ${n.promoted}/${n.waitlist}`)
  if (d.game.signupOpensAt) {
    parts.push(t < d.game.signupOpensAt ? `开放提醒 ${n.openPending} 人待发` : `开放提醒已送达 ${n.openDelivered} 人`)
  }
  return `通知：${parts.join(' · ')}`
}

let clockSkew = 0 // serverNow - Date.now()
const now = () => Date.now() + clockSkew

function cancelPhase(g: GameDetail['game'], t: number): Phase {
  if (t < g.cancelDeadlineAt) return 'free'
  if (t < g.startAt - g.penaltyWindowMin * MIN) return 'warn'
  return 'penalty'
}

function toRow(r: RegView, settled: boolean, fines: GameFine[]): Row {
  let badge = ''
  let badgeClass = ''
  if (r.status === 'registered') {
    if (settled && r.attendance) {
      badge = ATTENDANCE_TEXT[r.attendance]
      badgeClass = r.attendance === 'on_time' ? 'tag-ok' : 'tag-bad'
    } else if (r.checkinAt) {
      badge = `已签到 ${fmtTimeSec(r.checkinAt)}`
      badgeClass = 'tag-ok'
    }
  } else if (r.status === 'cancelled') {
    if (r.cancelledFrom === 'waitlist') {
      badge = '退出替补'
    } else if (r.cancelPhase === 'penalty') {
      badge = '临时取消'
      badgeClass = 'tag-bad'
    } else if (r.cancelPhase === 'warn') {
      badge = '截止后取消'
      badgeClass = 'tag-warn'
    }
  }
  const t = r.status === 'registered' ? r.spotAt : r.status === 'waitlist' ? r.waitlistAt : r.cancelledAt
  return {
    ...r,
    badge,
    badgeClass,
    timeText: t ? fmtShort(t) : '',
    ...fineInfo(fines.filter((f) => f.openid === r.openid)),
  }
}

Page({
  data: {
    id: '',
    inviter: '',
    loaded: false,
    d: null as GameDetail | null,
    timeText: '',
    localText: '',
    registered: [] as Row[],
    waitlist: [] as Row[],
    cancelled: [] as Row[],
    tab: 'registered',
    list: [] as Row[], // 当前 tab 显示的名单
    settled: false,
    ended: false,
    started: false, // 开赛后不能报名
    pastCutoff: false, // 截止后不能取消
    // 按钮状态
    myStatus: '',
    signupNotOpen: false,
    full: false,
    canCheckin: false,
    checkinNotYet: false,
    checkinOpensText: '',
    unpaidText: '',
    fineText: '',
    myCheckinText: '',
    notifyText: '', // 管理员看的通知覆盖情况
    formatStr: '',
    teamSizesText: '',
    tagStats: '', // 如“已付款 18/24”
    myTags: [] as { tag: string; on: boolean }[],
    // 取消后的转发提示
    shareDialog: { show: false, phase: '' as '' | Phase, fined: false },
    // 管理员取消/改时间后的“转发到群”提示
    showProfile: false,
    changeTemplate: !!CHANGED_TEMPLATE_ID,
    openTemplate: !!OPEN_TEMPLATE_ID,
    notice: { show: false, kind: '' as '' | 'cancelled' | 'changed', notified: 0 },
    // 管理员签到码
    code: { show: false, value: '', refreshText: '' },
  },

  codeTimer: 0 as number,

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ id: query.id || '', inviter: query.inviter || '' })
    wx.showShareMenu({ menus: ['shareAppMessage'] })
  },

  async onShow() {
    await this.load()
    const changed = takeFlash<{ gameId: string; notified: number }>('gameChanged')
    if (changed && changed.gameId === this.data.id) {
      this.setData({ notice: { show: true, kind: 'changed', notified: changed.notified } })
    }
  },

  onHide() {
    this.stopCode()
  },

  onUnload() {
    this.stopCode()
  },

  async onPullDownRefresh() {
    await this.load()
    wx.stopPullDownRefresh()
  },

  async load() {
    const d = await run<GameDetail>('getGame', { gameId: this.data.id }, this.data.loaded ? '' : '加载中')
    if (!d) return
    clockSkew = d.serverNow - Date.now()
    this.render(d)
  },

  // 根据比赛数据刷新界面（不请求服务器）
  render(d: GameDetail) {
    const g = d.game
    const t = now()
    const settled = !!g.settledAt
    const reg = d.me.reg
    const myStatus = reg ? reg.status : ''
    this.setData({
      loaded: true,
      d,
      ...gameTimeText(g),
      settled,
      ended: t >= g.endAt,
      started: t >= g.startAt,
      pastCutoff: t >= g.cutoffAt,
      registered: d.registered.map((r) => toRow(r, settled, d.fines || [])),
      waitlist: d.waitlist.map((r) => toRow(r, settled, d.fines || [])),
      cancelled: d.cancelled.map((r) => toRow(r, settled, d.fines || [])),
      myStatus,
      signupNotOpen: !!g.signupOpensAt && t < g.signupOpensAt,
      full: g.registeredCount >= g.capacity,
      canCheckin: myStatus === 'registered' && !reg!.checkinAt && t >= d.me.checkinOpensAt && t <= g.endAt,
      checkinNotYet: myStatus === 'registered' && !reg!.checkinAt && t < d.me.checkinOpensAt,
      checkinOpensText: fmtTime(d.me.checkinOpensAt),
      unpaidText: d.me.unpaidCents > 0 ? money(d.me.unpaidCents) : '',
      fineText: money(g.fineCents),
      formatStr: formatText(g.teamSize || 8, g.teamCount || 3),
      teamSizesText: d.teams ? d.teams.teams.map((t) => `${t.name} 队 ${t.members.length} 人`).join(' · ') : '',
      tagStats: (g.tags || [])
        .map((tag) => `${tag} ${d.registered.filter((r) => (r.tags || []).includes(tag)).length}/${d.registered.length}`)
        .join(' · '),
      myTags:
        reg && reg.status === 'registered' ? (g.tags || []).map((tag) => ({ tag, on: (reg.tags || []).includes(tag) })) : [],
      myCheckinText: reg && reg.checkinAt ? fmtTimeSec(reg.checkinAt) : '',
      notifyText: notifyText(d, t),
    })
    this.updateList()
    wx.setNavigationBarTitle({ title: g.title })
  },

  switchTab(e: WechatMiniprogram.TouchEvent) {
    this.setData({ tab: e.currentTarget.dataset.tab })
    this.updateList()
  },

  updateList() {
    const { tab, registered, waitlist, cancelled } = this.data
    this.setData({ list: tab === 'waitlist' ? waitlist : tab === 'cancelled' ? cancelled : registered })
  },

  openMap() {
    const v = this.data.d!.game.venue
    wx.openLocation({ latitude: v.lat, longitude: v.lng, name: v.name, address: v.address, scale: 16 })
  },

  // ---------- 报名 ----------

  // “报名”和“排队替补”走同一流程：页面可能没刷新，点“报名”时其实已经满员，
  // 结果要等服务端返回才知道，而订阅授权只能在点击当下申请，所以两种通知都先申请
  onSignup() {
    return this.join()
  },

  onWaitlist() {
    return this.join()
  },

  async join() {
    const sub = await askSubscribe([PROMOTED_TEMPLATE_ID, CHANGED_TEMPLATE_ID])
    const subscribed = !!sub[PROMOTED_TEMPLATE_ID]
    if (!(await this.readyToSignup())) return
    const res = await run<{ status: string }>(
      'signup',
      {
        gameId: this.data.id,
        inviter: this.data.inviter,
        subscribed,
        subscribedChange: !!sub[CHANGED_TEMPLATE_ID],
        envVersion: envVersion(),
      },
      '报名中',
    )
    if (!res) return
    if (res.status === 'registered') {
      wx.showToast({ title: '报名成功', icon: 'success' })
    } else {
      wx.showModal({
        title: '名额已满，已进入替补',
        content: subscribed ? '有人取消时会自动递补，并通过微信通知你。' : '有人取消时会自动递补。你没有开启通知，请留意群消息。',
        showCancel: false,
      })
    }
    this.load()
  },

  async readyToSignup(): Promise<boolean> {
    const d = this.data.d!
    if (d.me.unpaidCents > 0) {
      wx.showModal({
        title: '有未付罚款',
        content: `你有未付罚款 ${money(d.me.unpaidCents)}。请${d.club.venmo ? `Venmo ${d.club.venmo} 或` : ''}现金支付给管理员，管理员确认后即可报名。`,
        showCancel: false,
      })
      return false
    }
    try {
      if (!(await needsProfile())) return true
      const ok = await this.askProfile()
      // 已有昵称的人点“取消”只是跳过头像，照常报名
      return ok || !!(await getSession()).nickname
    } catch (e) {
      toastError(e)
      return false
    }
  },

  // ---------- 完善资料弹窗 ----------

  profileResolve: null as null | ((ok: boolean) => void),

  askProfile(): Promise<boolean> {
    return new Promise((resolve) => {
      this.profileResolve = resolve
      this.setData({ showProfile: true })
    })
  },

  onProfileDone() {
    this.setData({ showProfile: false })
    if (this.profileResolve) this.profileResolve(true)
    this.profileResolve = null
  },

  onProfileCancel() {
    this.setData({ showProfile: false })
    if (this.profileResolve) this.profileResolve(false)
    this.profileResolve = null
  },

  // ---------- 取消 ----------

  async onCancel() {
    const d = this.data.d!
    const g = d.game
    const isWaitlist = this.data.myStatus === 'waitlist'
    const phase: Phase = isWaitlist ? 'free' : cancelPhase(g, now())
    const content = isWaitlist
      ? '确定退出替补？'
      : phase === 'free'
        ? '确定取消报名？'
        : phase === 'warn'
          ? `已过缺席不转发罚款截止时间（${g.local.cancelDeadline}）。取消后必须转发到群里，方便别人递补。`
          : `距开赛不足 ${g.penaltyWindowMin} 分钟，取消将视为缺席，产生 ${money(g.fineCents)} 罚款（管理员可视情况豁免）。仍要取消？`
    const ok = await wx.showModal({
      title: isWaitlist ? '退出替补' : '取消报名',
      content,
      confirmText: '确定取消',
      confirmColor: phase === 'free' ? '#111111' : '#d4380d',
      cancelText: '再想想',
    })
    if (!ok.confirm) return
    const res = await run<{ phase: Phase; fined: boolean }>('cancelSignup', { gameId: this.data.id }, '处理中')
    if (!res) return
    await this.load()
    if (isWaitlist) {
      wx.showToast({ title: '已退出替补', icon: 'none' })
      return
    }
    this.setData({ shareDialog: { show: true, phase: res.phase, fined: res.fined } })
  },

  closeShareDialog() {
    this.setData({ 'shareDialog.show': false })
  },

  // ---------- 签到 ----------

  async onCheckin() {
    let loc: WechatMiniprogram.GetLocationSuccessCallbackResult
    try {
      wx.showLoading({ title: '定位中', mask: true })
      loc = await wx.getLocation({ type: 'wgs84', isHighAccuracy: true, highAccuracyExpireTime: 5000 })
      wx.hideLoading()
    } catch (e: any) {
      wx.hideLoading()
      const msg = String((e && e.errMsg) || '')
      if (/auth|deny|denied/i.test(msg)) {
        const r = await wx.showModal({
          title: '需要位置权限',
          content: '签到需要确认你在球场附近，请在设置里允许使用位置信息。',
          confirmText: '去设置',
        })
        if (r.confirm) wx.openSetting({})
      } else {
        wx.showModal({ title: '定位失败', content: '请确认手机定位已开启后重试，或向管理员要签到码。', showCancel: false })
      }
      return
    }
    // iPhone/安卓只给微信“大致位置”时，误差有几公里，怎么签都不在范围内
    if (loc.accuracy && loc.accuracy > Math.max(500, this.data.d!.game.venue.radiusM * 3)) {
      wx.showModal({
        title: '定位不够精确',
        content: `当前定位误差约 ${Math.round(loc.accuracy)} 米，可能只开了“大致位置”。\niPhone：设置 → 微信 → 位置 → 打开“精确位置”。\n安卓：系统设置 → 应用 → 微信 → 位置 → 允许使用精确位置。\n也可以向管理员要签到码。`,
        showCancel: false,
      })
      return
    }
    const res = await run<{ attendance: string; distanceM?: number }>(
      'checkin',
      { gameId: this.data.id, lat: loc.latitude, lng: loc.longitude, accuracy: loc.accuracy },
      '签到中',
    )
    if (!res) return
    this.afterCheckin(res.attendance)
  },

  async onCheckinByCode() {
    const r = await wx.showModal({ title: '输入签到码', content: '', editable: true, placeholderText: '管理员手机上的 4 位数字' })
    const code = (r.content || '').trim()
    if (!r.confirm || !code) return
    const res = await run<{ attendance: string }>('checkin', { gameId: this.data.id, code }, '签到中')
    if (!res) return
    this.afterCheckin(res.attendance)
  },

  afterCheckin(attendance: string) {
    if (attendance === 'on_time') {
      wx.showToast({ title: '签到成功', icon: 'success' })
    } else {
      wx.showModal({ title: '已签到', content: '已超过签到截止时间，本次记为迟到。', showCancel: false })
    }
    this.load()
  },

  // ---------- 管理员 ----------

  onEdit() {
    const g = this.data.d!.game
    wx.navigateTo({ url: `/pages/game-edit/game-edit?clubId=${g.clubId}&gameId=${g._id}` })
  },

  async onCancelGame() {
    const r = await wx.showModal({
      title: '取消比赛',
      content: '',
      editable: true,
      placeholderText: '取消原因，如：下雨场地湿滑',
      confirmText: '取消比赛',
      confirmColor: '#d4380d',
      cancelText: '返回',
    })
    if (!r.confirm) return
    const res = await run<{ notified: number }>('cancelGame', { gameId: this.data.id, reason: r.content || '' }, '处理中')
    if (!res) return
    await this.load()
    this.setData({ notice: { show: true, kind: 'cancelled', notified: res.notified } })
  },

  async onSetOpenReminder() {
    const sub = await askSubscribe([OPEN_TEMPLATE_ID])
    if (!sub[OPEN_TEMPLATE_ID]) {
      wx.showToast({ title: '未开启通知', icon: 'none' })
      return
    }
    if (await run('setOpenReminder', { gameId: this.data.id, envVersion: envVersion() }, '')) {
      wx.showToast({ title: '已设置提醒', icon: 'success' })
      this.load()
    }
  },

  async onArchiveGame() {
    const r = await wx.showModal({
      title: '删除比赛',
      content: '这场比赛将从近期和历史列表中移除，罚款等记录不受影响。',
      confirmText: '删除',
      confirmColor: '#d4380d',
    })
    if (!r.confirm) return
    if (await run('archiveGame', { gameId: this.data.id }, '删除中')) {
      wx.showToast({ title: '已删除', icon: 'success' })
      setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) }), 600)
    }
  },

  closeNotice() {
    this.setData({ 'notice.show': false })
  },

  async onSubscribeChange() {
    const sub = await askSubscribe([CHANGED_TEMPLATE_ID])
    if (!sub[CHANGED_TEMPLATE_ID]) {
      wx.showToast({ title: '未开启通知', icon: 'none' })
      return
    }
    if (await run('subscribeChange', { gameId: this.data.id, envVersion: envVersion() }, '')) {
      wx.showToast({ title: '已开启', icon: 'success' })
      this.load()
    }
  },

  // ---------- 标签 ----------

  onToggleMyTag(e: WechatMiniprogram.TouchEvent) {
    const reg = this.data.d && this.data.d.me.reg
    if (!reg) return
    const tag: string = e.currentTarget.dataset.tag
    this.toggleTagFor(reg.openid, tag, !(reg.tags || []).includes(tag))
  },

  // 先改界面再后台保存；失败则恢复并提示。不整页重新加载
  tagBusy: {} as Record<string, boolean>,

  async toggleTagFor(openid: string, tag: string, on: boolean) {
    const key = `${openid}:${tag}`
    if (this.tagBusy[key]) return
    this.tagBusy[key] = true
    this.setTagLocal(openid, tag, on)
    try {
      const isMe = openid === this.data.d!.me.openid
      await call('toggleTag', { gameId: this.data.id, tag, on, target: isMe ? undefined : openid })
    } catch (err) {
      this.setTagLocal(openid, tag, !on)
      toastError(err)
    } finally {
      this.tagBusy[key] = false
    }
  },

  setTagLocal(openid: string, tag: string, on: boolean) {
    const d = this.data.d
    if (!d) return
    const patch = (r: RegView): RegView => {
      if (r.openid !== openid) return r
      const rest = (r.tags || []).filter((t) => t !== tag)
      return { ...r, tags: on ? [...rest, tag] : rest }
    }
    this.render({
      ...d,
      registered: d.registered.map(patch),
      me: { ...d.me, reg: d.me.reg ? patch(d.me.reg) : null },
    })
  },

  // 管理员随时可改本场标签（比赛结算后也可以）
  async onEditTags() {
    const cur = (this.data.d!.game.tags || []).join('，')
    const r = await wx.showModal({
      title: '修改可选标签',
      content: cur,
      editable: true,
      placeholderText: '如：已付款（最多 3 个，逗号分隔）',
    })
    if (!r.confirm) return
    const tags = (r.content || '').split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean)
    if (await run('setGameTags', { gameId: this.data.id, tags }, '保存中')) this.load()
  },

  // ---------- 复制名单 ----------

  onCopyRoster() {
    const d = this.data.d
    if (!d) return
    const g = d.game
    const withTags = (r: RegView) => r.name + ((r.tags || []).length ? ` [${(r.tags || []).join('][')}]` : '')
    const lines = [g.title, `${g.local.start}–${g.local.end}`, `📍 ${g.venue.name}`, `已报名 ${d.registered.length}/${g.capacity}`]
    if (this.data.tagStats) lines.push(this.data.tagStats)
    this.data.registered.forEach((r, i) => lines.push(`${i + 1}. ${withTags(r)}`))
    if (this.data.waitlist.length) {
      lines.push('', '替补：')
      this.data.waitlist.forEach((r, i) => lines.push(`${i + 1}. ${r.name}`))
    }
    wx.setClipboardData({ data: lines.join('\n') })
  },

  // ---------- 分队 ----------

  openTeams() {
    wx.navigateTo({ url: `/pages/teams/teams?id=${this.data.id}` })
  },

  async onFormTeams() {
    const t = this.data.d!.teams!
    const r = await wx.showModal({
      title: '立即分队',
      content: `把已签到的 ${t.checkedIn} 人平均随机分到 ${this.data.d!.game.teamCount} 个队，之后签到的人补到人最少的队。`,
    })
    if (r.confirm && (await run('formTeamsNow', { gameId: this.data.id }, '分队中'))) this.load()
  },

  async onReshuffle() {
    const r = await wx.showModal({ title: '重新随机', content: '首批分队的人重新随机分配，后来签到的人不变。守门员顺序也会重排。' })
    if (r.confirm && (await run('reshuffleTeams', { gameId: this.data.id }, '分队中'))) this.load()
  },

  async toggleCode() {
    if (this.data.code.show) {
      this.stopCode()
      this.setData({ 'code.show': false })
      return
    }
    this.setData({ 'code.show': true })
    await this.refreshCode()
    this.codeTimer = setInterval(() => this.refreshCode(), 10 * 1000) as unknown as number
  },

  async refreshCode() {
    try {
      const c = await call<{ code: string; refreshAt: number }>('getCheckinCode', { gameId: this.data.id })
      this.setData({ 'code.value': c.code, 'code.refreshText': `${fmtTime(c.refreshAt)} 更新` })
    } catch (e) {
      this.stopCode()
      toastError(e)
    }
  },

  stopCode() {
    if (this.codeTimer) clearInterval(this.codeTimer)
    this.codeTimer = 0
  },

  async onPersonTap(e: WechatMiniprogram.TouchEvent) {
    const d = this.data.d!
    if (!d.me.isAdmin) return
    const openid: string = e.currentTarget.dataset.openid
    const name: string = e.currentTarget.dataset.name
    const status: string = e.currentTarget.dataset.status
    const phase: string = e.currentTarget.dataset.phase
    const row = this.data.list.find((x) => x.openid === openid)
    const items: { label: string; run: () => Promise<unknown> }[] = []
    if (row && row.pendingFineIds.length) {
      const resolve = (op: string, extra: Record<string, string>) =>
        run('resolveFines', { clubId: d.game.clubId, fineIds: row.pendingFineIds, op, ...extra }, '处理中')
      items.push({
        label: `豁免罚款（${row.pendingFineText}）`,
        run: async () => {
          const r = await wx.showModal({ title: `豁免 ${name} 的罚款`, content: '', editable: true, placeholderText: '原因（必填），如：家里有事' })
          const note = (r.content || '').trim()
          if (!r.confirm) return null
          if (!note) {
            wx.showToast({ title: '请填写原因', icon: 'none' })
            return null
          }
          return resolve('waived', { note })
        },
      })
      items.push({
        label: '罚款已付…',
        run: async () => {
          const methods = ['venmo', 'cash']
          try {
            const m = await wx.showActionSheet({ itemList: ['Venmo', '现金'] })
            return resolve('paid', { method: methods[m.tapIndex] })
          } catch (err) {
            return null
          }
        },
      })
    }
    if (status === 'cancelled' && phase === 'warn' && d.game.fineCents > 0 && row && !row.fineText) {
      items.push({
        label: `罚款：缺席未转发（${money(d.game.fineCents)}）`,
        run: async () => {
          const r = await wx.showModal({
            title: '缺席未转发',
            content: `确认 ${name} 缺席后没有转发到群里？将产生 ${money(d.game.fineCents)} 罚款，可在罚款管理里豁免。`,
          })
          if (!r.confirm) return null
          const ok = await run('fineNoForward', { gameId: this.data.id, target: openid }, '处理中')
          if (ok) wx.showToast({ title: '已添加罚款', icon: 'success' })
          return ok
        },
      })
    }
    const setAtt = (attendance: string) => () =>
      run('setAttendance', { gameId: this.data.id, target: openid, attendance }, '处理中')
    if (status === 'registered') {
      if (this.data.settled) {
        items.push({
          label: '修正出勤…',
          run: async () => {
            const opts = [
              { label: '准时（撤销迟到/未到罚款）', v: 'on_time' },
              { label: '迟到', v: 'late' },
              { label: '未到', v: 'no_show' },
            ]
            try {
              const r = await wx.showActionSheet({ itemList: opts.map((o) => o.label) })
              return setAtt(opts[r.tapIndex].v)()
            } catch (err) {
              return null
            }
          },
        })
      } else {
        items.push({ label: '代签到（记为准时）', run: setAtt('on_time') })
      }
    }
    const tags = d.game.tags || []
    if (status === 'registered' && tags.length && row) {
      items.push({
        label: '标签…',
        run: async () => {
          const mine = row.tags || []
          try {
            const r = await wx.showActionSheet({ itemList: tags.map((t) => (mine.includes(t) ? `✓ ${t}（点击取消）` : t)) })
            const tag = tags[r.tapIndex]
            this.toggleTagFor(openid, tag, !mine.includes(tag))
            return null // 已即时更新界面，不必整页刷新
          } catch (err) {
            return null
          }
        },
      })
    }
    items.push({
      label: '添加其他罚款（如穿钉鞋）',
      run: async () => {
        const r1 = await wx.showModal({ title: `罚款：${name}`, content: '', editable: true, placeholderText: '原因，如：穿钉鞋踩伤人' })
        const note = (r1.content || '').trim()
        if (!r1.confirm || !note) return null
        const r2 = await wx.showModal({ title: '金额（美元）', content: String(d.game.fineCents / 100 || 5), editable: true })
        const dollars = Number(r2.content)
        if (!r2.confirm) return null
        if (!(dollars > 0)) {
          wx.showToast({ title: '金额无效', icon: 'none' })
          return null
        }
        return run(
          'addFine',
          { clubId: d.game.clubId, target: openid, amountCents: Math.round(dollars * 100), note, gameId: this.data.id },
          '保存中',
        )
      },
    })
    items.push({
      label: '修改名字',
      run: async () => {
        const r = await wx.showModal({ title: '修改名字', content: name, editable: true, placeholderText: '群里大家认识的名字' })
        const next = (r.content || '').trim()
        if (!r.confirm || !next || next === name) return null
        return run('renameMember', { clubId: d.game.clubId, target: openid, name: next }, '保存中')
      },
    })
    try {
      const sheet = await wx.showActionSheet({ itemList: items.slice(0, 6).map((i) => i.label) })
      const done = await items[sheet.tapIndex].run()
      if (done) this.load()
    } catch (e) {
      // 取消了操作菜单
    }
  },

  // ---------- 分享 ----------

  onShareAppMessage() {
    const d = this.data.d
    this.closeShareDialog()
    if (!d) return { title: '比赛报名', path: `/pages/game/game?id=${this.data.id}` }
    this.closeNotice()
    const me = d.me.reg
    const who = me ? me.name : ''
    const g = d.game
    // 成员转发算自己邀请；还不是成员（没报过名）时，把原邀请人传下去
    const inviter = d.me.isMember ? d.me.openid : this.data.inviter
    const path = `/pages/game/game?id=${g._id}${inviter ? `&inviter=${inviter}` : ''}`
    if (g.status === 'cancelled') {
      return { title: `⚠️ 比赛取消（${g.cancelReason || '管理员取消'}）：${g.local.start} ${g.venue.name}`, path }
    }
    if (this.data.notice.kind === 'changed' && g.lastChange) {
      return { title: `⚠️ 比赛变更：${g.lastChange.text}，点击查看`, path }
    }
    let title = `${g.local.start} ${g.venue.name}，报名踢球`
    if (me && me.status === 'registered') title = `@所有人 “${who}” 参加该比赛，点击查看比赛详情`
    if (me && me.status === 'cancelled') title = `@所有人 “${who}” 缺席该比赛，有空位可以递补`
    return { title, path }
  },
})
