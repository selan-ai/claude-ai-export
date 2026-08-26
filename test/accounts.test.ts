import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canHoldConversations,
  classifyOrganization,
  describeConversationCount,
  MessageKind,
  type OrganizationChoice,
  OrganizationKind,
  parseExportMessage,
} from '@/domain'

/**
 * The shapes here were read off a live account holding all three organizations
 * at once — a Console one, a work seat and a personal Max subscription, every
 * one of them on the same email address. That account is the reason the export
 * has to name its source at all.
 */

test('an organization without chat is not a candidate', () => {
  assert.equal(canHoldConversations(['api']), false)
  assert.equal(canHoldConversations([]), false)
  assert.equal(canHoldConversations(['raven', 'chat']), true)
})

test('a seat tier means work, a consumer plan means personal', () => {
  const email = 'tomas@podimo.com'

  assert.equal(
    classifyOrganization(
      { name: 'Podimo', capabilities: ['raven', 'chat'], seatTier: 'team_tier_1' },
      email,
    ),
    OrganizationKind.work,
  )
  assert.equal(
    classifyOrganization(
      {
        name: "tomas@podimo.com's Organization",
        capabilities: ['chat', 'claude_max'],
        seatTier: null,
      },
      email,
    ),
    OrganizationKind.personal,
  )
})

test('a personal organization is recognised by its name when the plan is unfamiliar', () => {
  assert.equal(
    classifyOrganization(
      { name: "someone@example.com's Organization", capabilities: ['chat'], seatTier: null },
      'someone@example.com',
    ),
    OrganizationKind.personal,
  )
})

/** The safer reading wins: unproven-personal is called work, never the reverse. */
test('an organization that cannot be shown to be personal is called work', () => {
  assert.equal(
    classifyOrganization({ name: 'Podimo', capabilities: ['chat'], seatTier: null }, 'a@b.com'),
    OrganizationKind.work,
  )
})

test('a full first page is reported as a floor, not a total', () => {
  const choice = (conversationsSeen: number, moreThanSeen: boolean): OrganizationChoice => ({
    uuid: 'a4d83f9b-cb7c-4324-87fd-c41a9248eeba',
    name: 'Podimo',
    kind: OrganizationKind.work,
    seatTier: null,
    conversationsSeen,
    moreThanSeen,
  })

  assert.equal(describeConversationCount(choice(1, false)), '1 chat')
  assert.equal(describeConversationCount(choice(8, false)), '8 chats')
  assert.equal(describeConversationCount(choice(50, true)), '50+ chats')
})

test('a choice of account survives the boundary it has to cross', () => {
  assert.deepEqual(
    parseExportMessage({ kind: MessageKind.chooseAccount, organizationUuid: 'abc' }),
    { kind: MessageKind.chooseAccount, organizationUuid: 'abc' },
  )
  assert.equal(parseExportMessage({ kind: 'chooseEverything' }), null)
})
