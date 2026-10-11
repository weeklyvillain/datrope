// Package perms calculates permissions. It is pure: no I/O.
// Spec §4 describes the algorithm; Effective is the only place it lives.
package perms

// Perms is a 64-bit permission mask. It travels as a JSON number; the
// flags stay far below 2^53, so JavaScript can hold it exactly.
type Perms uint64

const (
	ViewChannel Perms = 1 << iota
	SendMessages
	AttachFiles
	ReadHistory
	ConnectVoice
	Speak
	Stream
	ManageMessages
	MuteMembers
	MoveMembers
	Kick
	Ban
	CreateInvite
	ManageRoles
	ManageChannels
	ManageServer
	Admin
	AddReactions
	CreateThreads
	UseSoundboard
	ManageExpressions
	ManageWebhooks
	MentionEveryone
	MentionRoles
)

// All is every flag.
const All Perms = MentionRoles<<1 - 1

// Default is what @everyone gets on a new server.
const Default = ViewChannel | SendMessages | AttachFiles | ReadHistory | ConnectVoice | Speak | Stream | CreateInvite |
	AddReactions | CreateThreads | UseSoundboard

// GuestDefault is what the Guest role gets when it is created.
const GuestDefault = ViewChannel | ReadHistory | SendMessages | ConnectVoice | Speak

// SelfAssignPower is what a role members give themselves may never grant.
const SelfAssignPower = Admin | ManageMessages | ManageRoles | ManageChannels | ManageServer | ManageExpressions |
	ManageWebhooks | Kick | Ban | MuteMembers | MoveMembers | MentionEveryone | MentionRoles

// SelfAssignSafe reports whether a role granting p may be self-assignable.
func SelfAssignSafe(p Perms) bool { return p&SelfAssignPower == 0 }

// DM is the fixed set every DM participant holds (reactions included).
const DM = ViewChannel | SendMessages | AttachFiles | ReadHistory | ConnectVoice | Speak | Stream | AddReactions | UseSoundboard

// WebhookMasked is what a webhook channel takes from everyone, the owner and
// admins included: only its webhooks post there. Its threads keep it.
const WebhookMasked = SendMessages | AttachFiles

// overridable is what a channel override may allow or deny.
const overridable = All &^ Admin

func (p Perms) Has(q Perms) bool { return p&q == q }

type Override struct{ Allow, Deny Perms }

// Member describes one member of the server.
type Member struct {
	IsOwner bool
	Roles   []Perms // masks of every role the member holds, including @everyone
}

// Channel holds the overrides that apply to one member in one channel.
type Channel struct {
	Everyone Override   // the @everyone override (zero if none)
	Roles    []Override // overrides for roles the member holds
	Member   *Override  // the member's own override, if any
}

// Base is the server-level permission set: the OR of all roles.
func Base(m Member) Perms {
	if m.IsOwner {
		return All
	}
	var p Perms
	for _, r := range m.Roles {
		p |= r
	}
	if p.Has(Admin) {
		return All
	}
	return p
}

// Effective is the member's permission set in a channel (spec §4 steps 1–6).
func Effective(m Member, c Channel) Perms {
	p := Base(m)
	if p.Has(Admin) {
		return All
	}
	p = p&^(c.Everyone.Deny&overridable) | c.Everyone.Allow&overridable
	var allow, deny Perms
	for _, o := range c.Roles {
		allow |= o.Allow
		deny |= o.Deny
	}
	p = p&^(deny&overridable) | allow&overridable
	if c.Member != nil {
		p = p&^(c.Member.Deny&overridable) | c.Member.Allow&overridable
	}
	if !p.Has(ViewChannel) {
		return 0
	}
	return p
}
