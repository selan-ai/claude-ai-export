import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coworkPrompt, cronToLocal, prepare, promptOf } from '@/claude/ScheduledTasks'

const mondayTask = {
  id: 't1',
  name: 'Monday good morning message',
  cron_expression: '0 5 * * 1',
  run_once_at: null,
  next_run_at: '2026-08-24T05:05:01.375066971Z',
  enabled: true,
  job_config: {
    ccr: { events: [{ data: { message: { content: 'Write a warm good morning message.' } } }] },
  },
}

test('cron is converted from UTC into local time', () => {
  process.env.TZ = 'Europe/Vilnius' // UTC+3 in August
  const { cron, converted } = cronToLocal('0 5 * * 1', '2026-08-24T05:05:01Z')
  assert.equal(converted, true)
  assert.equal(cron, '0 8 * * 1', '05:00 UTC is 08:00 in Vilnius')
})

test("the scheduler's jitter does not leak into the minute", () => {
  process.env.TZ = 'Europe/Vilnius'
  // next_run_at reports 05:05 for an 05:00 rule; the minute must come from the
  // cron, not from the observed fire time.
  const { cron } = cronToLocal('0 5 * * 1', '2026-08-24T05:05:01.375Z')
  assert.match(cron, /^0 /, `expected minute 0, got "${cron}"`)
})

test('a day rollover moves the weekday too', () => {
  process.env.TZ = 'Pacific/Auckland' // UTC+12, so 23:00 UTC Monday is Tuesday
  const { cron } = cronToLocal('0 23 * * 1', '2026-08-24T23:00:00Z')
  assert.equal(cron.split(' ')[4], '2', 'Monday 23:00 UTC is Tuesday locally')
})

test('a cron too complex to convert is left alone and flagged', () => {
  const [task] = prepare([{ ...mondayTask, cron_expression: '*/15 9-17 * * 1-5' }])
  assert.equal(task?.cron, '*/15 9-17 * * 1-5')
  assert.equal(task?.timeUnverified, true)
})

test('the prompt is read from job_config, not a top-level field', () => {
  assert.equal(promptOf(mondayTask), 'Write a warm good morning message.')
  assert.equal(promptOf({ ...mondayTask, job_config: null }), '')
})

test('both response shapes are accepted, and empty tasks dropped', () => {
  assert.equal(prepare({ data: [mondayTask] }).length, 1)
  assert.equal(prepare([mondayTask]).length, 1)
  assert.equal(prepare({ data: [{ ...mondayTask, job_config: null }] }).length, 0)
  assert.equal(prepare(null).length, 0)
})

test('the paste tells Claude to skip tasks that already exist', () => {
  process.env.TZ = 'Europe/Vilnius'
  const text = coworkPrompt(prepare([mondayTask]), 'Europe/Vilnius')
  assert.match(text, /list_scheduled_tasks first/)
  assert.match(text, /cronExpression: 0 8 \* \* 1/)
  assert.match(text, /Write a warm good morning message\./)
})
