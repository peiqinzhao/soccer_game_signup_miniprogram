import { run } from '../../utils/api'
import { money, fmtDate } from '../../utils/format'
import { LedgerEntry } from '../../utils/types'

interface Row extends LedgerEntry {
  amountText: string
  dateText: string
}

const TYPES = [
  { key: 'expense', label: '支出' },
  { key: 'income', label: '收入' },
  { key: 'opening', label: '期初余额' },
]

Page({
  data: {
    clubId: '',
    loaded: false,
    isAdmin: false,
    balanceText: '',
    incomeText: '',
    expenseText: '',
    entries: [] as Row[],
    showVoided: false,
    // 记账表单
    adding: false,
    types: TYPES,
    typeIndex: 0,
    amount: '',
    note: '',
    date: fmtDate(Date.now()),
    receipt: '',
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
    const res = await run<{
      isAdmin: boolean
      balanceCents: number
      incomeCents: number
      expenseCents: number
      entries: LedgerEntry[]
    }>('getLedger', { clubId: this.data.clubId }, this.data.loaded ? '' : '加载中')
    if (!res) return
    this.setData({
      loaded: true,
      isAdmin: res.isAdmin,
      balanceText: money(res.balanceCents),
      incomeText: money(res.incomeCents),
      expenseText: money(res.expenseCents),
      entries: res.entries.map((e) => ({
        ...e,
        amountText: (e.signedCents >= 0 ? '+' : '') + money(e.signedCents),
        dateText: fmtDate(e.date),
      })),
    })
  },

  toggleVoided() {
    this.setData({ showVoided: !this.data.showVoided })
  },

  startAdd() {
    this.setData({ adding: true, typeIndex: 0, amount: '', note: '', date: fmtDate(Date.now()), receipt: '' })
  },

  cancelAdd() {
    this.setData({ adding: false })
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  onPick(e: WechatMiniprogram.PickerChange) {
    const key = e.currentTarget.dataset.key as string
    this.setData({ [key]: key === 'typeIndex' ? Number(e.detail.value) : e.detail.value })
  },

  async pickReceipt() {
    try {
      const r = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] })
      const path = r.tempFiles[0].tempFilePath
      wx.showLoading({ title: '上传中' })
      const up = await wx.cloud.uploadFile({
        cloudPath: `receipts/${this.data.clubId}/${Date.now()}${path.slice(path.lastIndexOf('.'))}`,
        filePath: path,
      })
      wx.hideLoading()
      this.setData({ receipt: up.fileID })
    } catch (e) {
      wx.hideLoading()
    }
  },

  async submit() {
    const d = this.data
    const cents = Math.round(Number(d.amount) * 100)
    if (!(cents > 0)) {
      wx.showToast({ title: '请填写金额', icon: 'none' })
      return
    }
    const ok = await run(
      'addLedgerEntry',
      {
        clubId: d.clubId,
        type: TYPES[d.typeIndex].key,
        amountCents: cents,
        note: d.note,
        date: new Date(`${d.date}T12:00:00`).getTime(),
        receipt: d.receipt,
      },
      '保存中',
    )
    if (!ok) return
    this.setData({ adding: false })
    this.load()
  },

  preview(e: WechatMiniprogram.TouchEvent) {
    const url = e.currentTarget.dataset.url
    wx.previewImage({ urls: [url], current: url })
  },

  async onEntryLongPress(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.isAdmin) return
    const entry = this.data.entries[e.currentTarget.dataset.index]
    if (entry.voided) return
    if (entry.fineId) {
      wx.showModal({ title: '提示', content: '罚款收入请在“罚款管理 → 已付”里撤销。', showCancel: false })
      return
    }
    const r = await wx.showModal({ title: '作废这条记录？', content: `${entry.note} ${entry.amountText}`, confirmColor: '#d4380d' })
    if (!r.confirm) return
    if (await run('voidLedgerEntry', { clubId: this.data.clubId, entryId: entry._id }, '处理中')) this.load()
  },
})
