# 养生足球报名小程序

业余足球群用的微信小程序：报名、排队替补自动递补、GPS 到场签到、迟到/缺席自动罚款、罚款付清前禁止报名、球队基金账本。

需求与规则见 [docs/PRD.md](docs/PRD.md)。

## 目录

```
miniprogram/            小程序前端（原生 + TypeScript）
  config.ts             云环境 ID、订阅消息模板 ID
  pages/                home 比赛列表 / game 比赛详情 / game-edit 发起 / club 球队
                        club-edit 球队设置 / venue 场地 / fines 罚款 / ledger 基金 / me 我的
cloudfunctions/api/     唯一的云函数：所有读写 + 每 5 分钟的结算定时器
  lib/rules.js          纯规则（取消阶段、迟到判定、距离、签到码）
  lib/time.js           时区换算
  handlers/             user / club / game / fine / ledger / settle
  test/                 单元测试 + 内存数据库全流程测试
docs/PRD.md             产品需求
```

## 本地开发

1. 注册小程序（个人主体即可），拿到 AppID。云开发不支持测试号，必须用正式 AppID；未备案也可以开发和预览。
2. 把 `project.config.json` 里的 `appid` 换成你自己的 AppID，然后用微信开发者工具「导入项目」选择本目录。
3. 开发者工具顶部点「云开发」开通环境，把环境 ID 填到 `miniprogram/config.ts` 的 `ENV_ID`。
4. 在云开发控制台 → 数据库，新建集合：
   `users` `clubs` `members` `venues` `games` `registrations` `fines` `ledger` `reminders`
   每个集合的权限设为「自定义安全规则」：`{ "read": false, "write": false }`（所有读写都经过云函数）。
5. 右键 `cloudfunctions/api` →「上传并部署：云端安装依赖」。定时触发器在 `config.json` 里，部署后右键「上传触发器」。
   **务必在云开发控制台 → 云函数 → api → 触发器里确认状态是“已启用”**：迟到/缺席的自动判定和报名开放提醒都靠它，每 5 分钟运行一次；日志里应能看到 `{"settled": …, "reminded": …}`。
6. 编译运行。第一次进入先在「比赛」页点「创建球队」，然后在球队页添加场地、发起比赛。

建议给这些字段建索引（数据量小时可以不建）：
- `registrations`: `gameId`, `openid`
- `members`: `openid`, `clubId`
- `games`: `clubId + startAt`, `status + settledAt + cutoffAt`
- `fines`: `clubId + status`, `openid + status`
- `ledger`: `clubId + date`

## 可选：微信通知（订阅消息）

两类通知，各需在小程序后台 → 订阅消息 → 公共模板库选一个模板：

| 通知 | 模板示例 | 配置项 | 字段映射 |
|---|---|---|---|
| 替补成功 | “候补成功通知” | `PROMOTED_TEMPLATE_ID` | `buildPromotedData` |
| 比赛改时间/场地、取消 | “活动变更通知” | `CHANGED_TEMPLATE_ID` | `buildChangedData` |
| 报名开放提醒 | “活动报名通知” | `OPEN_TEMPLATE_ID` | `buildOpenData` |

模板 ID 同时填到 `miniprogram/config.ts` 和 `cloudfunctions/api/config.js`，并按模板的字段名修改对应函数。
订阅是一次性的：用户报名时授权一次，只能收到一条；比赛页有“比赛改时间或取消时通知我”可再次开启。

## 上线前

- 小程序后台 → 开发管理 → 接口设置，申请 `wx.getLocation` 和 `wx.chooseLocation`。
- 完成小程序备案后提交审核发布。

## 测试

```bash
npm install
npm test          # 规则单测 + 全流程测试（内存数据库，无需云环境）
npm run typecheck # 前端 TypeScript 类型检查
```

## License

MIT
