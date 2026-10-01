import { ENV_ID } from './config'

App<IAppOption>({
  globalData: {},
  onLaunch() {
    wx.cloud.init({ env: ENV_ID || undefined, traceUser: true })
  },
})
