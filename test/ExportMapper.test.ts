import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApiConversation, ApiProject } from '@/claude/ClaudeApi'
import { ExportMapper } from '@/claude/ExportMapper'

const emptyConversation = {
  uuid: 'c1',
  name: 'Test',
  updated_at: null,
  created_at: null,
  project_uuid: null,
  chat_messages: null,
} satisfies ApiConversation

test('an artifact block becomes text, because the importer keeps nothing else', () => {
  const mapper = new ExportMapper()
  const result = mapper.mapConversation({
    ...emptyConversation,
    chat_messages: [
      {
        uuid: 'm1',
        parent_message_uuid: null,
        sender: 'assistant',
        text: '',
        content: [
          {
            type: 'tool_use',
            text: null,
            name: 'artifacts',
            content: null,
            input: { title: 'Dashboard', language: 'html', content: '<h1>hi</h1>' },
          },
        ],
        created_at: '2026-01-01T00:00:00Z',
        attachments: null,
        files: null,
      },
    ],
  })

  const block = result.chat_messages[0]?.content[0]
  assert.equal(block?.type, 'text')
  assert.match(block?.text ?? '', /\*\*Dashboard\*\*/)
  assert.match(block?.text ?? '', /<h1>hi<\/h1>/)
  assert.deepEqual(mapper.diagnostics.seen, { tool_use: 1 })
})

test('project instructions are read into prompt_template, whatever they were called', () => {
  const mapper = new ExportMapper()
  const source = {
    uuid: 'p1',
    name: 'Ops',
    prompt_template: null,
    instructions: 'Answer in Lithuanian.',
    description: 'unused',
  } satisfies ApiProject

  assert.equal(mapper.mapProject(source, [], []).prompt_template, 'Answer in Lithuanian.')
})

test('an attachment without extracted_content is dropped rather than failing the message', () => {
  const mapper = new ExportMapper()
  const result = mapper.mapConversation({
    ...emptyConversation,
    chat_messages: [
      {
        uuid: 'm1',
        parent_message_uuid: null,
        sender: 'human',
        text: 'hello',
        content: null,
        created_at: '',
        attachments: [
          { file_name: 'bad.pdf', extracted_content: null },
          { file_name: 'good.txt', extracted_content: 'body' },
        ],
        files: null,
      },
    ],
  })

  assert.equal(result.chat_messages[0]?.attachments.length, 1)
  assert.equal(result.chat_messages[0]?.attachments[0]?.file_name, 'good.txt')
})
