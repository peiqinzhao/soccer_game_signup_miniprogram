// 完善资料弹窗：头像用 chooseAvatar（菜单第一项是“使用微信头像”），
// 昵称用 type="nickname" 输入框（键盘上方会出现“使用微信昵称”）。
// 用 form 提交取昵称：选微信昵称时 bindinput 不一定触发。
import { call, toastError } from '../../utils/api'
import { getSession, setSession, Session } from '../../utils/session'

Component({
  options: { addGlobalClass: true },
  properties: {
    show: { type: Boolean, value: false },
  },
  data: {
    avatar: '',
    nickname: '',
    saving: false,
  },
  observers: {
    show(v: boolean) {
      if (v) this.init()
    },
  },
  methods: {
    async init() {
      try {
        const s = await getSession()
        this.setData({ avatar: s.avatar, nickname: s.nickname })
      } catch (e) {
        // 忽略，表单为空
      }
    },

    onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
      this.setData({ avatar: e.detail.avatarUrl })
    },

    async onSubmit(e: WechatMiniprogram.CustomEvent<{ value: { nickname?: string } }>) {
      const nickname = String(e.detail.value.nickname || '').trim()
      if (!nickname) {
        wx.showToast({ title: '请填写昵称', icon: 'none' })
        return
      }
      this.setData({ saving: true })
      try {
        const s = await getSession()
        let avatar: string | undefined = this.data.avatar || undefined
        // 新选的头像是本地临时文件，先传到云存储
        if (avatar && !avatar.startsWith('cloud://')) {
          const up = await wx.cloud.uploadFile({ cloudPath: `avatars/${s.openid}_${Date.now()}.jpg`, filePath: avatar })
          avatar = up.fileID
        }
        const next = await call<Session>('updateProfile', { nickname, avatar })
        setSession(next)
        this.triggerEvent('done', next)
      } catch (err) {
        toastError(err)
      } finally {
        this.setData({ saving: false })
      }
    },

    onCancel() {
      this.triggerEvent('cancel')
    },

    noop() {},
  },
})
