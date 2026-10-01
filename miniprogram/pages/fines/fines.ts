import { run } from '../../utils/api'
import { money, fmtShort } from '../../utils/format'
import { Fine } from '../../utils/types'

interface FineRow extends Fine {
  amountText: string
  dateText: string
  statusText: string
  checked: boolean
}

const STATUS_TEXT: Record<string, string> = { pending: '待处理', paid: '已付', waived: '已豁免' }
const METHOD_TEXT: Record<string, string> = { venmo: 'Venmo', cash: '现金' }

Page({
  data: {
    clubId: '',
    loaded: false,
    isAdmin: false,
    venmo: '',
    tab: 'pending',
    tabs: [
      { key: 'pending', label: '待处理' },
      { key: 'paid', label: '已付' },
      { key: 'waived', label: '已豁免' },
    ],
    fines: [] as FineRow[],
    selectedCount: 0,
    selectedText: '',
    totalText: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ clubId: q.clubId || '' })
    this.load()
  },

  async onPullDownRefresh() {
    await this.load()
    wx.stopPullDownRefresh()
  },

  async load() {
    const res = await run<{ fines: Fine[]; isAdmin: boolean; venmo: string }>(
      'listFines',
      { clubId: this.data.clubId, status: this.data.tab },
      this.data.loaded ? '' : '加载中',
    )
    if (!res) return
    const fines = res.fines.map((f) => ({
      ...f,
      amountText: money(f.amountCents),
      dateText: fmtShort(f.createdAt),
      statusText:
        STATUS_TEXT[f.status] + (f.status === 'paid' && f.method ? ` · ${METHOD_TEXT[f.method] || f.method}` : ''),
      checked: false,
    }))
    wx.setNavigationBarTitle({ title: res.isAdmin ? '罚款管理' : '我的罚款' })
    this.setData({
      loaded: true,
      isAdmin: res.isAdmin,
      venmo: res.venmo,
      fines,
      totalText: money(fines.reduce((s, f) => s + f.amountCents, 0)),
    })
    this.updateSelected()
  },

  switchTab(e: WechatMiniprogram.TouchEvent) {
    this.setData({ tab: e.currentTarget.dataset.key })
    this.load()
  },

  onRowTap(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.isAdmin) return
    if (this.data.tab === 'pending') this.toggle(e)
    else this.onResolvedTap(e)
  },

  toggle(e: WechatMiniprogram.TouchEvent) {
    const i: number = e.currentTarget.dataset.index
    this.setData({ [`fines[${i}].checked`]: !this.data.fines[i].checked })
    this.updateSelected()
  },

  toggleAll() {
    const all = this.data.fines.length > 0 && this.data.fines.every((f) => f.checked)
    this.setData({ fines: this.data.fines.map((f) => ({ ...f, checked: !all })) })
    this.updateSelected()
  },

  updateSelected() {
    const sel = this.data.fines.filter((f) => f.checked)
    this.setData({ selectedCount: sel.length, selectedText: money(sel.reduce((s, f) => s + f.amountCents, 0)) })
  },

  selectedIds(): string[] {
    return this.data.fines.filter((f) => f.checked).map((f) => f._id)
  },

  async markPaid(e: WechatMiniprogram.TouchEvent) {
    const method = e.currentTarget.dataset.method
    const ids = this.selectedIds()
    const r = await wx.showModal({
      title: '标记已付',
      content: `${ids.length} 笔共 ${this.data.selectedText}，通过${METHOD_TEXT[method]}支付。会自动记入足球基金。`,
    })
    if (!r.confirm) return
    if (await run('resolveFines', { clubId: this.data.clubId, fineIds: ids, op: 'paid', method }, '处理中')) this.load()
  },

  async waive() {
    const ids = this.selectedIds()
    const r = await wx.showModal({ title: `豁免 ${ids.length} 笔罚款`, content: '', editable: true, placeholderText: '原因（必填），如：家里有事' })
    const note = (r.content || '').trim()
    if (!r.confirm) return
    if (!note) {
      wx.showToast({ title: '请填写原因', icon: 'none' })
      return
    }
    if (await run('resolveFines', { clubId: this.data.clubId, fineIds: ids, op: 'waived', note }, '处理中')) this.load()
  },

  async onResolvedTap(e: WechatMiniprogram.TouchEvent) {
    const f = this.data.fines[e.currentTarget.dataset.index]
    try {
      await wx.showActionSheet({ itemList: ['撤销，改回待处理'] })
    } catch (err) {
      return
    }
    const r = await wx.showModal({
      title: '撤销',
      content: f.status === 'paid' ? '对应的基金收入也会作废。' : '改回待处理后，该成员将不能报名直到处理完。',
    })
    if (!r.confirm) return
    if (await run('resolveFines', { clubId: this.data.clubId, fineIds: [f._id], op: 'reopen' }, '处理中')) this.load()
  },
})
