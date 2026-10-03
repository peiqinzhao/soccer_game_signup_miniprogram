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
  { key: 'cancelDeadlineDaysBefore', label: '缺席不转发罚款截止（比赛前）', unit: '天' },
]

Page({
  data: {
    clubId: '',
    ready: false,
    showProfile: false,
    name: '',
    venmo: '',
    fineDollars: '5',
    cancelDeadlineTime: '21:00',
    defaultTagsText: '',
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
      name: c.club.name,
      venmo: c.club.venmo,
      fineDollars: String(s.fineCents / 100),
      cancelDeadlineTime: s.cancelDeadlineTime,
      defaultTagsText: (s.defaultTags || []).join('，'),
      tzLabels: TIMEZONES.map((t) => t.label),
      tzIndex,
      nums,
    })
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

  onPick(e: WechatMiniprogram.PickerChange) {
    const key = e.currentTarget.dataset.key as string
    this.setData({ [key]: key === 'tzIndex' ? Number(e.detail.value) : e.detail.value })
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
    }
    for (const { key } of NUM_FIELDS) settings[key] = Number(d.nums[key])
    const ok = await run('updateClub', { clubId: d.clubId, name: d.name, venmo: d.venmo, settings }, '保存中')
    if (!ok) return
    await getSession(true)
    wx.showToast({ title: '已保存', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 600)
  },
})
