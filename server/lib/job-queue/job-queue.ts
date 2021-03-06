import * as Bull from 'bull'
import { JobState, JobType } from '../../../shared/models'
import { logger } from '../../helpers/logger'
import { CONFIG, JOB_ATTEMPTS, JOB_COMPLETED_LIFETIME, JOB_CONCURRENCY, JOB_REQUEST_TTL } from '../../initializers'
import { ActivitypubHttpBroadcastPayload, processActivityPubHttpBroadcast } from './handlers/activitypub-http-broadcast'
import { ActivitypubHttpFetcherPayload, processActivityPubHttpFetcher } from './handlers/activitypub-http-fetcher'
import { ActivitypubHttpUnicastPayload, processActivityPubHttpUnicast } from './handlers/activitypub-http-unicast'
import { EmailPayload, processEmail } from './handlers/email'
import { processVideoFile, processVideoFileImport, VideoFileImportPayload, VideoFilePayload } from './handlers/video-file'
import { ActivitypubFollowPayload, processActivityPubFollow } from './handlers/activitypub-follow'

type CreateJobArgument =
  { type: 'activitypub-http-broadcast', payload: ActivitypubHttpBroadcastPayload } |
  { type: 'activitypub-http-unicast', payload: ActivitypubHttpUnicastPayload } |
  { type: 'activitypub-http-fetcher', payload: ActivitypubHttpFetcherPayload } |
  { type: 'activitypub-follow', payload: ActivitypubFollowPayload } |
  { type: 'video-file-import', payload: VideoFileImportPayload } |
  { type: 'video-file', payload: VideoFilePayload } |
  { type: 'email', payload: EmailPayload }

const handlers: { [ id in JobType ]: (job: Bull.Job) => Promise<any>} = {
  'activitypub-http-broadcast': processActivityPubHttpBroadcast,
  'activitypub-http-unicast': processActivityPubHttpUnicast,
  'activitypub-http-fetcher': processActivityPubHttpFetcher,
  'activitypub-follow': processActivityPubFollow,
  'video-file-import': processVideoFileImport,
  'video-file': processVideoFile,
  'email': processEmail
}

const jobsWithRequestTimeout: { [ id in JobType ]?: boolean } = {
  'activitypub-http-broadcast': true,
  'activitypub-http-unicast': true,
  'activitypub-http-fetcher': true,
  'activitypub-follow': true
}

const jobTypes: JobType[] = [
  'activitypub-follow',
  'activitypub-http-broadcast',
  'activitypub-http-fetcher',
  'activitypub-http-unicast',
  'email',
  'video-file',
  'video-file-import'
]

class JobQueue {

  private static instance: JobQueue

  private queues: { [ id in JobType ]?: Bull.Queue } = {}
  private initialized = false
  private jobRedisPrefix: string

  private constructor () {}

  async init () {
    // Already initialized
    if (this.initialized === true) return
    this.initialized = true

    this.jobRedisPrefix = 'bull-' + CONFIG.WEBSERVER.HOST
    const queueOptions = {
      prefix: this.jobRedisPrefix,
      redis: {
        host: CONFIG.REDIS.HOSTNAME,
        port: CONFIG.REDIS.PORT,
        auth: CONFIG.REDIS.AUTH,
        db: CONFIG.REDIS.DB
      }
    }

    for (const handlerName of Object.keys(handlers)) {
      const queue = new Bull(handlerName, queueOptions)
      const handler = handlers[handlerName]

      queue.process(JOB_CONCURRENCY[handlerName], handler)
        .catch(err => logger.error('Cannot execute job queue %s.', handlerName, { err }))

      queue.on('error', err => {
        logger.error('Error in job queue %s.', handlerName, { err })
        process.exit(-1)
      })

      this.queues[handlerName] = queue
    }
  }

  createJob (obj: CreateJobArgument) {
    const queue = this.queues[obj.type]
    if (queue === undefined) {
      logger.error('Unknown queue %s: cannot create job.', obj.type)
      return
    }

    const jobArgs: Bull.JobOptions = {
      backoff: { delay: 60 * 1000, type: 'exponential' },
      attempts: JOB_ATTEMPTS[obj.type]
    }

    if (jobsWithRequestTimeout[obj.type] === true) {
      jobArgs.timeout = JOB_REQUEST_TTL
    }

    return queue.add(obj.payload, jobArgs)
  }

  async listForApi (state: JobState, start: number, count: number, asc?: boolean): Promise<Bull.Job[]> {
    let results: Bull.Job[] = []

    // TODO: optimize
    for (const jobType of jobTypes) {
      const queue = this.queues[ jobType ]
      if (queue === undefined) {
        logger.error('Unknown queue %s to list jobs.', jobType)
        continue
      }

      // FIXME: Bull queue typings does not have getJobs method
      const jobs = await (queue as any).getJobs(state, 0, start + count, asc)
      results = results.concat(jobs)
    }

    results.sort((j1: any, j2: any) => {
      if (j1.timestamp < j2.timestamp) return -1
      else if (j1.timestamp === j2.timestamp) return 0

      return 1
    })

    if (asc === false) results.reverse()

    return results.slice(start, start + count)
  }

  async count (state: JobState): Promise<number> {
    let total = 0

    for (const type of jobTypes) {
      const queue = this.queues[ type ]
      if (queue === undefined) {
        logger.error('Unknown queue %s to count jobs.', type)
        continue
      }

      const counts = await queue.getJobCounts()

      total += counts[ state ]
    }

    return total
  }

  removeOldJobs () {
    for (const key of Object.keys(this.queues)) {
      const queue = this.queues[key]
      queue.clean(JOB_COMPLETED_LIFETIME, 'completed')
    }
  }

  static get Instance () {
    return this.instance || (this.instance = new this())
  }
}

// ---------------------------------------------------------------------------

export {
  JobQueue
}
