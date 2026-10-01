import { run } from '../../utils/api'
import { ClubDetail } from '../../utils/types'

Page({
  data: {
    clubId: '',
    venueId: '',
    name: '',
    address: '',
    lat: '',
    lng: '',
    radiusM: '100',
    coordsText: '',
  },

  async onLoad(q: Record<string, string | undefined>) {
    const clubId = q.clubId || ''
    const venueId = q.venueId || ''
    this.setData({ clubId, venueId })
    const c = await run<ClubDetail>('getClub', { clubId })
    if (!c) return
    const v = c.venues.find((x) => x._id === venueId)
    if (v) {
      this.setData({ name: v.name, address: v.address, lat: String(v.lat), lng: String(v.lng), radiusM: String(v.radiusM) })
    } else {
      this.setData({ radiusM: String(c.club.settings.checkinRadiusM) })
      wx.setNavigationBarTitle({ title: '添加场地' })
    }
    this.updateCoordsText()
  },

  updateCoordsText() {
    const { lat, lng } = this.data
    this.setData({ coordsText: lat && lng ? `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}` : '未设置' })
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  async chooseOnMap() {
    try {
      const r = await wx.chooseLocation({
        latitude: this.data.lat ? Number(this.data.lat) : undefined,
        longitude: this.data.lng ? Number(this.data.lng) : undefined,
      } as WechatMiniprogram.ChooseLocationOption)
      this.setData({
        lat: String(r.latitude),
        lng: String(r.longitude),
        name: this.data.name || r.name,
        address: r.address || this.data.address,
      })
      this.updateCoordsText()
    } catch (e) {
      // 取消选择
    }
  },

  async useCurrent() {
    try {
      wx.showLoading({ title: '定位中' })
      const r = await wx.getLocation({ type: 'wgs84', isHighAccuracy: true, highAccuracyExpireTime: 5000 })
      wx.hideLoading()
      this.setData({ lat: String(r.latitude), lng: String(r.longitude) })
      this.updateCoordsText()
      wx.showToast({ title: `精度约 ${Math.round(r.accuracy)}m`, icon: 'none' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '定位失败', icon: 'none' })
    }
  },

  // 支持从 Google Maps 复制的 “37.3861, -122.0839”
  async pasteCoords() {
    const r = await wx.showModal({ title: '粘贴坐标', content: '', editable: true, placeholderText: '37.3861, -122.0839' })
    if (!r.confirm) return
    const m = (r.content || '').match(/(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/)
    if (!m) {
      wx.showToast({ title: '格式不对', icon: 'none' })
      return
    }
    this.setData({ lat: m[1], lng: m[2] })
    this.updateCoordsText()
  },

  async save() {
    const d = this.data
    if (!d.lat || !d.lng) {
      wx.showToast({ title: '请先设置坐标', icon: 'none' })
      return
    }
    const venue = { _id: d.venueId || undefined, name: d.name, address: d.address, lat: d.lat, lng: d.lng, radiusM: d.radiusM }
    if (await run('saveVenue', { clubId: d.clubId, venue }, '保存中')) wx.navigateBack()
  },

  async remove() {
    const r = await wx.showModal({ title: '删除场地', content: '已发起的比赛不受影响。', confirmColor: '#d4380d' })
    if (!r.confirm) return
    if (await run('deleteVenue', { clubId: this.data.clubId, venueId: this.data.venueId }, '删除中')) wx.navigateBack()
  },
})
