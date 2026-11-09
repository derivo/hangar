import { randomBytes } from 'node:crypto';
import { open, seal, type Envelope } from './envelope';
import type { Identity } from './identity';
import type { Workspace } from './members';
import type { ReplayGuard } from './replay';

/**
 * One instance in one workspace for the lifetime of a connection: seals messages to members
 * and opens those from members. Only members of a list younger than seven days get through.
 */
export class Endpoint {
  /** New per connection, so numbers may start at 1 again after a restart. */
  readonly epoch = randomBytes(16).toString('base64url');
  private readonly seq = new Map<string, number>();

  constructor(
    private readonly identity: Identity,
    private readonly workspace: Workspace,
    private readonly guard: ReplayGuard,
    private readonly now: () => number = Date.now,
  ) {}

  send(to: string, body: string): Envelope {
    const recipient = this.workspace.member(to, new Date(this.now()));
    if (!recipient) throw new Error('Recipient is not a member of the workspace');
    const seq = (this.seq.get(to) ?? 0) + 1;
    this.seq.set(to, seq);
    return seal(
      this.identity,
      recipient,
      { workspace: this.workspace.name, epoch: this.epoch, seq, ts: this.now() },
      body,
    );
  }

  /** Verifies, decrypts and records the message before the caller acts on it. */
  receive(envelope: Envelope): string {
    const now = this.now();
    if (envelope.header.workspace !== this.workspace.name)
      throw new Error('Message for another workspace');
    const sender = this.workspace.member(envelope.header.from, new Date(now));
    if (!sender) throw new Error('Sender is not a member of the workspace');
    const body = open(this.identity, sender, envelope);
    this.guard.accept(envelope.header, now);
    return body;
  }
}
