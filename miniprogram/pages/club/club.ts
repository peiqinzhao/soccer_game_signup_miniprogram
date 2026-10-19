import { run } from '../../utils/api'
import { getSession } from '../../utils/session'
import { ClubDetail } from '../../utils/types'

const ROLE_TEXT: Record<string, string> = { owner: '创建者', admin: '管理员', member: '' }

Page({
  data: {
    id: '',
    c: null as ClubDetail | null,
    roleText: ROLE_TEXT,
    myOpenid: '',
    levelPicker: [] as string[], // ['不填', ...可选等级]
  },

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ id: q.id || '' })
  },

  onShow() {
    this.load()
  },

  async onPullDownRefresh() {
    await this.load()
    wx.stopPullDownRefresh()
  },

  async load() {
    const [c, s] = await Promise.all([
      run<ClubDetail>('getClub', { clubId: this.data.id }, this.data.c ? '' : '加载中'),
      getSession().catch(() => null),
    ])
    if (!c) return
    this.setData({
      c,
      myOpenid: s ? s.openid : '',
      levelPicker: (c.levelOptions || []).length ? ['不填', ...(c.levelOptions || [])] : [],
    })
    wx.setNavigationBarTitle({ title: c.club.name })
  },

  go(e: WechatMiniprogram.TouchEvent) {
    const id = this.data.id
    const to = e.currentTarget.dataset.to
    const urls: Record<string, string> = {
      newGame: `/pages/game-edit/game-edit?clubId=${id}`,
      fines: `/pages/fines/fines?clubId=${id}`,
      stats: `/pages/stats/stats?clubId=${id}`,
      ledger: `/pages/ledger/ledger?clubId=${id}`,
      settings: `/pages/club-edit/club-edit?clubId=${id}`,
      newVenue: `/pages/venue/venue?clubId=${id}`,
    }
    wx.navigateTo({ url: urls[to] })
  },

  async onPickLevel(e: WechatMiniprogram.PickerChange) {
    const i = Number(e.detail.value)
    const level = i === 0 ? '' : this.data.levelPicker[i]
    if (await run('setMyLevel', { clubId: this.data.id, level }, '保存中')) this.load()
  },

  editVenue(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/venue/venue?clubId=${this.data.id}&venueId=${e.currentTarget.dataset.id}` })
  },

  async onMemberTap(e: WechatMiniprogram.TouchEvent) {
    const c = this.data.c!
    if (!c.me.isAdmin) return
    const m = c.members[e.currentTarget.dataset.index]
    const clubId = this.data.id
    const items: { label: string; run: () => Promise<unknown> }[] = [
      {
        label: '修改名字',
        run: async () => {
          const r = await wx.showModal({ title: '修改名字', content: m.name, editable: true })
          const name = (r.content || '').trim()
          if (!r.confirm || !name || name === m.name) return null
          return run('renameMember', { clubId, target: m.openid, name }, '保存中')
        },
      },
      ...(c.club.settings.finesEnabled === false ? [] : [{
        label: '添加罚款',
        run: async () => {
          const reason = await wx.showModal({ title: `给 ${m.name} 添加罚款`, content: '', editable: true, placeholderText: '原因，如：穿非 turf 鞋伤人' })
          const note = (reason.content || '').trim()
          if (!reason.confirm || !note) return null
          const amt = await wx.showModal({ title: '金额（美元）', content: String(c.club.settings.fineCents / 100), editable: true })
          const dollars = Number(amt.content)
          if (!amt.confirm || !(dollars > 0)) return null
          return run('addFine', { clubId, target: m.openid, amountCents: Math.round(dollars * 100), note }, '保存中')
        },
      }]),
    ]
    if (c.me.isOwner && m.role !== 'owner') {
      const toAdmin = m.role !== 'admin'
      items.push({
        label: toAdmin ? '设为管理员' : '取消管理员',
        run: () => run('setRole', { clubId, target: m.openid, role: toAdmin ? 'admin' : 'member' }, '保存中'),
      })
    }
    try {
      const sheet = await wx.showActionSheet({ itemList: items.map((i) => i.label) })
      if (await items[sheet.tapIndex].run()) this.load()
    } catch (err) {
      // 取消
    }
  },
})
