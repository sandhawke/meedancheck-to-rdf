const fs = require('fs')
const kgx = require('kgx')
const read = require('./read-csv')
const csvStringify = require('csv-stringify/lib/sync')
const debug = require('debug')('meedancheck-to-rdf')
const {fetchCSV} = require('./remote')
const is = require('@sindresorhus/is');

/*
  attributes of a Converter are basically the yargs, hopefully
  documented by cli.js and/or the readme
*/

class Converter {
  constructor (state) {
    this.records = []
    this.kb = kgx.memKB()
    Object.assign(this, state)
  }

  async load (filename) {
    const nrecs = await read.readCSV(filename)
    this.records.push(...nrecs)
    debug('Read %d rows from %s, now have %d',
          nrecs.length, filename, this.records.length)
  }

  
  async loadQMeta () {
    this.meta = {}
    if (this.qmeta) {
      debug('fetching %o', this.qmeta)
      this.fromQMeta = await fetchCSV(this.qmeta)
      // debug('.. got %O', this.fromQMeta)
      for (const qm of this.fromQMeta) {
        this.meta[qm['Task Question']] = qm
      }
      // debug('.. this.meta = %O', this.meta)
    }
  }

  toObservations () {
    this.observations = []
    for (const r of this.records) {
      for (let t = 1; t <= 999999; t++) {
        const user = r[`task_user_${t}`]
        if (!user) break
        const question = r[`task_question_${t}`]
        const answer = r[`task_answer_${t}`]
        const date = new Date(r[`task_date_${t}`])
        const note = new Date(r[`task_note_${t}`])

        let meta = this.meta[question]
        if (!meta) {
          meta = {}
          this.meta[question] = meta
        }
        
        // keep link to record around, for various metadata.  Would
        // be cleaner to copy out the fields we care about, maybe?
        const obs = {user, question, answer, date, note, meta, record: r}
        this.observations.push(obs)
      }
    }
  }

  /* async */
  writeQMeta (outStream) {
    return new Promise(resolve => {
      const rows = []
      for (const [question, meta] of Object.entries(this.meta)) {
        const row = Object.assign({}, meta)
        row['Task Question'] = question
        rows.push(row)
      }
      const opts = {
        header: true,
        columns: ['Task Question', 'Type']
      }
      outStream.write(csvStringify(rows, opts), 'utf8', resolve)
    })
  }

  // use type, etc
  //
  // to build obs.signalDef
  //              readingObjectDef, readingObjectValue, readingValue

  shredAll (...args) {
    for (const obs of this.observations) {
      this.shred(obs, ...args)
    }
  }
  
  /**
   * Turn an observation + graph shape into some triples in the kb
   *
   * The graph shape is a kgx.pattern, some trig with variables.
   * 
   * You can also pass a function which runs on the bindings to fill
   * in more of them.
   *
   **/
  shred (obs, pattern, ...funcs) {
    const bindings = Object.assign({}, obs)

    /*  INTERESTING IDEA BUT SERIOUS SECURITY RISK, UNLESS I UNDERSTAND
        WHERE the func might be coming from

        if (is.string(f)) {
          let {user, question, answer, date, note, meta, record} = obs
          Object.assign(bindings, eval(f))
    */
    
    // run each func, letting it alter or replace the bindings
    for (const f of funcs) {
      const r = f(bindings)
      if (r) bindings = r
    }

    if (!pattern || !bindings) throw ('bad arguments: ' + JSON.stringify(
      {pattern, bindings, obs, funcs}, null, 2))
    this.kb.addBound(pattern, bindings)
  }

  /* the flags, from --help    (bumped, camped, vamped, temped, romped, ... :-)
  -m, --metadata-style                                 [array] [default: ["ng"]]
  -p, --predicate-style                      [array] [default: ["tf","nc","ag"]]
  -e, --encoding-depends-on                     [array] [default: ["all","one"]]
  -d, --direct                                         [array] [default: [true]]
  */
  run (flags) {
    const  {mstyle, pstyle, dstyle, estyle} = flags
    let pat, pfunc, mfunc

    // should unbounds be genid'd?
    // it'd be nice to parameterize that for re-use.
    //    kb.blankFor(serializableObject)
    // just like in Horn logic

    
    // pstyle determines func, sets signal, reading
    switch (pstyle) {
    case 'tf':
      pfunc = b => {
        b.signal = this.kb.ns.x[b.question + b.answer]  // NOT REALLY
        b.reading = true
      }
      break;
    case 'mc':
      pfunc = b => {
        b.signal = this.kb.ns.x[b.question]  // NOT REALLY
        b.reading = b.answer
      }
      break;
    }
    
    if (mstyle === 'ng') {
      mfunc = b => {
        b.subject = this.kb.blankNode()
        b.obs = this.kb.blankNode()
      }
      pat = `
?obs { ?subject ?signal ?reading }
?obs x:by ?user;
     dc:date ?date.`
    }

    if (pat && pfunc && mfunc) {
      this.shredAll(pat, pfunc, mfunc)
    } else {
      console.error('Combination not implemented %o', flags)
    }
  }
}


function convert (records) {
  let obsCount = 0
  let my

  // This goes in qmap too!   qmeta
  const ansType = []
  ansType[ 1] = credlevel
  ansType[ 6] = bool
  ansType[10] = numeric
  ansType[12] = lik5
  ansType[15] = numeric
  ansType[16] = lik5
  ansType[17] = numeric
  ansType[18] = numeric
  ansType[19] = numeric
  ansType[20] = numeric
  ansType[22] = lik5
  ansType[23] = lik5
  // ansType[24] = credlevel   also "No change" is an option here.

  return records2rdf(records)

  function records2rdf (records) {
    const kb = kgx.memKB()
    kb.base = 'https://base-placeholder.example/'
    my = kb.ns('', kb.base + '#')
    for (const r of records) {
      describe(r, kb)
    }
    return kb
    // await kb.writeToFile('./out.trig')
  }

  function credlevel (kb, text) {
    const options = {}
    const index = ["Very low credibility", "Somewhat low credibility", "Medium credibility", "Somewhat high credibility", "Very high credibility"].indexOf(text)
    if (index === -1) {
      console.error(`bad value "${text}" for credibility rating`)
      return undefined
    }
    const val = index / 4
    options[kb.ns.rdf.value] = val
    return kb.defined(`The response "${text}", when the possible responses are "Very high credibility", "Somewhat high credibility", "Medium credibility", "Somewhat low credibility", and "Very low credibility".`, {label: text, value: val})
  }

  function lik5 (kb, text) {
    const options = {}
    const index = ["Strongly disagree", "Somewhat disagree", "Neutral", "Somewhat agree", "Strongly agree"].indexOf(text)
    if (index === -1) {
      console.error(`bad value "${text}" for Likert-5 rating`)
      return undefined
    }
    const val = index - 2
    options[kb.ns.rdf.value] = val
    return kb.defined(`The response "${text}", when the possible responses are "Strongly disagree", "Somewhat disagree", "Neutral", "Somewhat agree", and "Strongly agree".`, {label: text, value: val})
  }

  function numeric (kb, text) {
    return kb.literal(parseInt(text))
  }
  function bool (kb, text) {
    if (text === 'true') return kb.literal(true)
    if (text === 'false') return kb.literal(false)
    return undefined
  }

  function describe(r, kb) {

    // the same subject occurs muliple times; hopefully these fields
    // will be the same or things will get a bit weird.
    const subject = kb.named(r.media_url)
    kb.add(subject, kb.ns.dct.title, r.report_title)
    kb.add(subject, kb.ns.dct.abstract, r.media_content)
    if (r.time_original_media_publishing) {
      kb.add(subject, kb.ns.dct.date, new Date(r.time_original_media_publishing))
    }
    // hm, turns out moment can't handle this format
    // kb.add(subject, kb.ns.dct.date, moment.parseZone(r.time_original_media_publishing))
    // and this is the date of the REPORT, whatever that means
    // kb.add(subject, kb.ns.dct.date, moment.parseZone(r.report_date).format())

    // let date = new Date('2018-04-23')
    let startTime
    for (let t = 1; t <= 25; t++) {
      const uid = r[`task_user_${t}`]
      const question = r[`task_question_${t}`]
      const answer = r[`task_answer_${t}`]
      const endTime = new Date(r[`task_date_${t}`])

      if (uid && question && answer) {
        const observer = kb.defined(`Test subject identified as "${uid}" in Zhang18 data release`, {label: 'Subj ' + uid})
        const property = kb.defined(question, {label: 'Question ' + t})

        let handler = ansType[t]
        let value
        if (handler) {
          // console.log('running', t, handler)
          value = handler(kb, answer)
        }
        if (value) {
          // console.log('output', t, value)
          
          const observation = my['n' + obsCount++]
          // const observation = kb.blank() // kb.ns.obs['n' + obsCount++] // obsns['n' + obsCount++]
          
          kb.add(subject, property, value, observation)
          kb.add(observation, kb.ns.cred.observer, observer)
          // valid time
          kb.add(observation, kb.ns.cred.startTime, startTime)
          kb.add(observation, kb.ns.cred.endTime, endTime)
          // transaction time (begins, in original db; when recorded)
          kb.add(observation, kb.ns.dct.date, endTime)
        }
        startTime = endTime // start of the next one is the end of this one
      }
    }
  }
}

module.exports = { convert, Converter }