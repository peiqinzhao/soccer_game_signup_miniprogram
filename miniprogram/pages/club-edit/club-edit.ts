import { run } from '../../utils/api'
import { getSession } from '../../utils/session'
import { TIMEZONES } from '../../utils/format'
import { ClubDetail } from '../../utils/types'

// 数字设置项
const NUM_FIELDS = [
  { key: 'capacity', label: '默认人数上限', unit: '人' },
  { key: 'durationMin', label: '默认时长', unit: '分钟' },
  { key: 'lateGraceMin', label: '迟到宽限', unit: '分钟' },
  { key: 'checkinRadiusM', label: '新场地签到范围', unit: '米' },
  { key: 'checkinOpenBeforeMin', label: '签到开放（开赛前）', unit: '分钟' },
  { key: 'penaltyWindowMin', label: '临时取消罚款（开赛前）', unit: '分钟' },
  { key: 'cancelDeadlineDaysBefore', label: '取消不转发罚款截止（比赛前）', unit: '天' },
]

Page({
  data: {
    clubId: '',
    ready: false,
    showProfile: false,
    isOwner: false,
    name: '',
    venmo: '',
    fineDollars: '5',
    cancelDeadlineTime: '21:00',
    defaultTagsText: '',
    checkinEnabled: true,
    finesEnabled: true,
    ratingModes: ['不使用', '文字档位（如 入门/中级/高手）', '数字等级（如 网球 1.0–7.0）'],
    ratingIndex: 0,
    ratingLabels: '入门，中级，高手',
    ratingMin: '1',
    ratingMax: '7',
    ratingStep: '0.5',
    tzLabels: TIMEZONES.map((t) => t.label),
    tzIndex: 0,
    numFields: NUM_FIELDS,
    nums: {} as Record<string, string>,
  },

  async onLoad(q: Record<string, string | undefined>) {
    const clubId = q.clubId || ''
    this.setData({ clubId })
    if (!clubId) {
      wx.setNavigationBarTitle({ title: '创建球队' })
      this.setData({ ready: true })
      return
    }
    const c = await run<ClubDetail>('getClub', { clubId })
    if (!c) return
    const s = c.club.settings
    const nums: Record<string, string> = {}
    for (const { key } of NUM_FIELDS) nums[key] = String((s as any)[key])
    let tzIndex = TIMEZONES.findIndex((t) => t.id === s.timezone)
    if (tzIndex < 0) {
      TIMEZONES.push({ id: s.timezone, label: s.timezone })
      tzIndex = TIMEZONES.length - 1
    }
    this.setData({
      ready: true,
      isOwner: c.me.isOwner,
      name: c.club.name,
      venmo: c.club.venmo,
      fineDollars: String(s.fineCents / 100),
      cancelDeadlineTime: s.cancelDeadlineTime,
      defaultTagsText: (s.defaultTags || []).join('，'),
      checkinEnabled: s.checkinEnabled !== false,
      finesEnabled: s.finesEnabled !== false,
      ratingIndex: ['off', 'labels', 'numeric'].indexOf((s.rating && s.rating.mode) || 'off'),
      ratingLabels: s.rating ? s.rating.labels.join('，') : '入门，中级，高手',
      ratingMin: s.rating ? String(s.rating.min) : '1',
      ratingMax: s.rating ? String(s.rating.max) : '7',
      ratingStep: s.rating ? String(s.rating.step) : '0.5',
      tzLabels: TIMEZONES.map((t) => t.label),
      tzIndex,
      nums,
    })
  },

  async onArchiveClub() {
    const r = await wx.showModal({
      title: '删除球队',
      content: '',
      editable: true,
      placeholderText: `输入“${this.data.name}”确认删除`,
      confirmText: '删除',
      confirmColor: '#d4380d',
    })
    if (!r.confirm) return
    const ok = await run('archiveClub', { clubId: this.data.clubId, confirmName: (r.content || '').trim() }, '删除中')
    if (!ok) return
    await getSession(true)
    wx.showToast({ title: '已删除', icon: 'success' })
    setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 600)
  },

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

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  onSwitch(e: WechatMiniprogram.SwitchChange) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  onPick(e: WechatMiniprogram.PickerChange) {
    const key = e.currentTarget.dataset.key as string
    this.setData({ [key]: key.endsWith('Index') ? Number(e.detail.value) : e.detail.value })
  },

  async save() {
    const d = this.data
    if (!d.clubId) {
      if (!(await getSession()).nickname && !(await this.askProfile())) return
      const res = await run<{ clubId: string }>('createClub', { name: d.name, venmo: d.venmo }, '创建中')
      if (!res) return
      await getSession(true)
      wx.redirectTo({ url: `/pages/club/club?id=${res.clubId}` })
      return
    }
    const settings: Record<string, unknown> = {
      timezone: TIMEZONES[d.tzIndex].id,
      fineCents: Math.round(Number(d.fineDollars) * 100),
      cancelDeadlineTime: d.cancelDeadlineTime,
      defaultTags: d.defaultTagsText,
      checkinEnabled: d.checkinEnabled,
      finesEnabled: d.finesEnabled,
      rating: {
        mode: ['off', 'labels', 'numeric'][d.ratingIndex],
        labels: d.ratingLabels,
        min: Number(d.ratingMin),
        max: Number(d.ratingMax),
        step: Number(d.ratingStep),
      },
    }
    for (const { key } of NUM_FIELDS) settings[key] = Number(d.nums[key])
    const ok = await run('updateClub', { clubId: d.clubId, name: d.name, venmo: d.venmo, settings }, '保存中')
    if (!ok) return
    await getSession(true)
    wx.showToast({ title: '已保存', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 600)
  },
})
