// 测试用：内存版 wx-server-sdk，只实现本项目用到的数据库 API。
const Module = require('module')

const store = {} // collection -> Map(id -> doc)
let idSeq = 0
let currentOpenid = ''
let clock = null // 可控时间
const sent = [] // 订阅消息

const cmd = (op, v) => ({ __cmd: op, v })
const command = {
  in: (v) => cmd('in', v),
  lt: (v) => cmd('lt', v),
  lte: (v) => cmd('lte', v),
  gte: (v) => cmd('gte', v),
  inc: (v) => cmd('inc', v),
  neq: (v) => cmd('neq', v),
  exists: (v) => cmd('exists', v),
}

function match(doc, where) {
  return Object.entries(where).every(([k, cond]) => {
    const val = doc[k]
    if (cond && cond.__cmd) {
      if (cond.__cmd === 'in') return cond.v.includes(val)
      if (cond.__cmd === 'lt') return val < cond.v
      if (cond.__cmd === 'lte') return val <= cond.v
      if (cond.__cmd === 'gte') return val >= cond.v
      if (cond.__cmd === 'neq') return val !== cond.v
      if (cond.__cmd === 'exists') return (val !== undefined) === cond.v
    }
    return val === cond
  })
}

function apply(doc, data) {
  for (const [k, v] of Object.entries(data)) {
    if (v && v.__cmd === 'inc') doc[k] = (doc[k] || 0) + v.v
    else doc[k] = v
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x))
const coll = (name) => (store[name] = store[name] || new Map())

function query(name, where = {}, order = [], lim = 100, skipN = 0) {
  const api = {
    where: (w) => query(name, w, order, lim, skipN),
    orderBy: (f, dir) => query(name, where, [...order, [f, dir]], lim, skipN),
    limit: (n) => query(name, where, order, n, skipN),
    skip: (n) => query(name, where, order, lim, n),
    async get() {
      let docs = [...coll(name).values()].filter((d) => match(d, where))
      for (const [f, dir] of [...order].reverse()) {
        docs.sort((a, b) => (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0) * (dir === 'desc' ? -1 : 1))
      }
      return { data: clone(docs.slice(skipN, skipN + lim)) }
    },
    async count() {
      return { total: [...coll(name).values()].filter((d) => match(d, where)).length }
    },
    async remove() {
      let removed = 0
      for (const [id, d] of [...coll(name).entries()]) {
        if (match(d, where)) {
          coll(name).delete(id)
          removed++
        }
      }
      return { stats: { removed } }
    },
    async update({ data }) {
      let updated = 0
      for (const d of coll(name).values()) {
        if (match(d, where)) {
          apply(d, data)
          updated++
        }
      }
      return { stats: { updated } }
    },
    doc: (id) => ({
      async get() {
        const d = coll(name).get(id)
        if (!d) throw new Error('not found')
        return { data: clone(d) }
      },
      async set({ data }) {
        coll(name).set(id, { ...clone(data), _id: id })
      },
      async update({ data }) {
        const d = coll(name).get(id)
        if (!d) throw new Error('not found')
        apply(d, data)
        return { stats: { updated: 1 } }
      },
      async remove() {
        coll(name).delete(id)
      },
    }),
    async add({ data }) {
      const id = `id${++idSeq}`
      coll(name).set(id, { ...clone(data), _id: id })
      return { _id: id }
    },
  }
  return api
}

const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database: () => ({ collection: (n) => query(n), command }),
  getWXContext: () => ({ OPENID: currentOpenid }),
  openapi: { subscribeMessage: { send: async (m) => sent.push(m) } },
  getTempFileURL: async ({ fileList }) => ({
    fileList: fileList.map((f) => ({ fileID: f.fileID, tempFileURL: `https://tmp.example/${f.fileID.slice(8)}` })),
  }),
}

const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'wx-server-sdk') return fakeSdk
  return origLoad.call(this, request, ...rest)
}

const realNow = Date.now
Date.now = () => (clock === null ? realNow() : clock)

module.exports = {
  store,
  sent,
  as(openid) {
    currentOpenid = openid
  },
  setNow(ms) {
    clock = ms
  },
  reset() {
    for (const k of Object.keys(store)) delete store[k]
    sent.length = 0
    clock = null
  },
}
