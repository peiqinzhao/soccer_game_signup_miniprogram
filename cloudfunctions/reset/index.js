// 一次性清理测试数据：清空【调用者自己创建的球队】的比赛、报名、罚款、基金流水、开放提醒。
// 账号、球队、成员、场地、模板都保留；别人的球队不受影响，所以即使忘了删除也不会误伤他人。
// 在开发者工具里右键 reset →「云端测试」（会带上你的身份），参数：{ "confirm": "DELETE" }
// 用完建议在云开发控制台删除云端的 reset 函数，避免手滑。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

async function removeWhere(name, where) {
  let removed = 0
  for (;;) {
    const res = await db.collection(name).where(where).remove()
    removed += res.stats.removed
    if (!res.stats.removed) return removed
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, error: '无法识别调用者，请在开发者工具里用“云端测试”运行' }
  if (event.confirm !== 'DELETE') return { ok: false, error: '请传入 { "confirm": "DELETE" }' }

  const clubs = (await db.collection('clubs').where({ ownerOpenid: OPENID }).limit(100).get()).data
  if (!clubs.length) return { ok: false, error: '你没有创建任何球队' }
  const clubIds = clubs.map((c) => c._id)
  const gameIds = []
  for (;;) {
    const page = (
      await db.collection('games').where({ clubId: _.in(clubIds) }).skip(gameIds.length).limit(100).get()
    ).data
    gameIds.push(...page.map((g) => g._id))
    if (page.length < 100) break
  }

  const removed = {
    reminders: gameIds.length ? await removeWhere('reminders', { gameId: _.in(gameIds) }) : 0,
    registrations: await removeWhere('registrations', { clubId: _.in(clubIds) }),
    fines: await removeWhere('fines', { clubId: _.in(clubIds) }),
    ledger: await removeWhere('ledger', { clubId: _.in(clubIds) }),
    games: await removeWhere('games', { clubId: _.in(clubIds) }),
  }
  return { ok: true, clubs: clubs.map((c) => c.name), removed }
}
