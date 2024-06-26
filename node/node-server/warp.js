const { cpSync, rmSync } = require("fs")
const Warp = require("weavedb-sdk-node")
const path = require("path")
const { map, sortBy, prop, path: _path, isNil, keys } = require("ramda")
const Snapshot = require("./lib/snapshot")
class Syncer {
  constructor({
    sequencerUrl,
    apiKey,
    contractTxId,
    bundler,
    dir,
    backup,
    dir_backup,
    arweave = {
      host: "arweave.net",
      port: 443,
      protocol: "https",
    },
    snapshot,
  }) {
    this.sequencerUrl = sequencerUrl
    this.apiKey = apiKey
    this.arweave = arweave
    this.partial_recovery = false
    this.full_recovery = false
    this.full_recovery_failure = false
    this.contractTxId = contractTxId
    this.bundler = bundler
    this.dir = dir
    this.dir_backup = dir_backup
    this.tx_count = 0
    if (!isNil(snapshot)) {
      this.snapshot_count = snapshot.count ?? 100
      this.snapshot = new Snapshot({
        ...snapshot,
        dir: this.dir,
      })
    }

    console.log("syncer...", this.dir, this.dir_backup)
  }
  async init() {
    console.log(`contractTxId: ${this.contractTxId}`)
    this.warp = new Warp({
      sequencerUrl: this.sequencerUrl,
      apiKey: this.apiKey,
      arweave: this.arweave,
      logLevel: "error",
      lmdb: { dir: this.dir },
      type: 3,
      contractTxId: this.contractTxId,
      remoteStateSyncEnabled: false,
      nocache: true,
      sequencerUrl: "https://gw.warp.cc/",
      progress: async input => {
        console.log(
          `loading ${this.contractTxId} [${input.currentInteraction}/${input.allInteractions}]`,
        )
      },
    })
    await this.warp.init({ wallet: this.bundler })
    const _state = await this.warp.readState()
    let len = 0
    try {
      len = keys(_state.cachedValue.validity).length
    } catch (e) {}
  }
  async commit(v, height) {
    const { bundles, t, hash } = v
    console.log(
      `[${height}],commiting to Warp...${map(_path(["data", "id"]))(bundles)}`,
    )
    const res = await this.warp.bundle(map(_path(["data", "input"]))(bundles), {
      t,
      h: hash,
      n: height,
      parallel: true,
    })
    if (isNil(res?.tx?.originalTxId)) return null
    return {
      hash,
      height,
      tx: res.tx,
      items: v,
      duration: res.duration,
    }
  }

  async bundle({ height, b, res: _res }) {
    let results = []
    let done = 0
    let isErr = false
    for (let v of b) {
      this.commit(v, ++height)
        .then(res => {
          if (!isNil(res)) results.push(res)
          done++
          if (done === b.length) {
            this.validate({
              success: !isErr,
              err: isErr,
              len: b.length,
              results,
              height,
              res: _res,
            })
          }
        })
        .catch(e => {
          done++
          console.log(e)
          if (done === b.length) {
            this.validate({
              success: !isErr,
              err: isErr,
              len: b.length,
              results,
              height,
              res: _res,
            })
          }
        })
    }
  }

  async validate({ success, err, len, results, height, res }) {
    let state = null
    if (success) {
      state =
        results.length === 0
          ? null
          : (await this.warp.db.readState())?.cachedValue
      let valid_height = 0
      try {
        valid_height = state?.state?.rollup?.height ?? 0
      } catch (e) {
        console.log(e)
      }
      console.log(`done committing(${len}) : valid height....`, valid_height)
      for (let v of sortBy(prop("height"))(results)) {
        if (v.height > valid_height) {
          err = true
          break
        }
      }
      if (err !== true) {
        this.partial_recovery = false
        this.full_recovery = false
        this.full_recovery_failure = false
        try {
          rmSync(this.dir_backup, {
            recursive: true,
            force: true,
          })
        } catch (e) {
          console.log(e)
        }
        try {
          cpSync(this.dir, this.dir_backup, {
            recursive: true,
          })
        } catch (e) {
          //console.log(e)
        }
      }
    }
    res({ state, success, err, len, results })
  }
  async recover() {
    console.log("lets recover...", this.partial_recovery, this.full_recovery)
    this.error_count = 0
    if (this.full_recovery_failure) {
      console.log("recovery failed....", Date.now())
      return false
    }
    if (this.full_recovery) {
      this.full_recovery_failure = true
      return false
    }
    try {
      rmSync(this.dir, { recursive: true, force: true })
    } catch (e) {
      console.log(e)
    }
    if (!this.partial_recovery) {
      this.partial_recovery = true
      console.log("partial recovery")
      try {
        cpSync(
          this.dir_backup,
          this.dir,

          {
            recursive: true,
          },
        )
      } catch (e) {
        console.log(e)
      }
    } else {
      this.full_recovery = true
      console.log("partial recovery failed... onto full recovery")
    }
    let initErr = false
    try {
      await this.init()
    } catch (e) {
      initErr = true
    }
    if (initErr) {
      await this.recover()
    } else {
      return true
    }
  }
  async getTxs() {
    return await this.warp.warp.interactionsLoader.load(
      this.contractTxId,
      null,
      null,
      {},
    )
  }
}

let syncer = null
process.on("message", async msg => {
  const { op, id, opt } = msg
  if (op === "init") {
    syncer = new Syncer(opt)
    let err = false
    try {
      await syncer.init()
    } catch (e) {
      console.log(e)
      err = true
    }
    process.send({ err, result: null, op, id })
  } else if (op === "bundle") {
    syncer.bundle({
      ...opt,
      res: async ({ err, success, results, state }) => {
        process.send({
          err,
          op,
          id,
          result: { err, results, success, state },
        })
        if (success && results.length > 0) {
          syncer.tx_count += 1
          try {
            if (
              !isNil(syncer.snapshot) &&
              syncer.tx_count >= syncer.snapshot_count
            ) {
              await syncer.snapshot.save(syncer.contractTxId)
              console.log(
                "snapshot successfully backed up!",
                syncer.contractTxId,
              )
              syncer.tx_count = 0
            }
          } catch (e) {
            console.log(e)
          }
        }
      },
    })
  } else if (op === "recover") {
    const success = await syncer.recover()
    process.send({
      err: !success,
      op,
      id,
      result: {
        partial_recovery: this.partial_recovery,
        full_recovery: this.full_recovery,
        full_recovery_failure: this.full_recovery_failure,
      },
    })
  } else if (op === "txs") {
    let txs = null
    let err = null
    try {
      txs = await syncer.getTxs()
    } catch (e) {
      console.log(e)
      err = true
    }
    process.send({ err, op, id, result: { txs } })
  } else {
  }
})
