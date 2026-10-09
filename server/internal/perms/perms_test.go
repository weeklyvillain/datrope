package perms

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEffective(t *testing.T) {
	member := Member{Roles: []Perms{ViewChannel | SendMessages | ReadHistory}} // @everyone only
	tests := []struct {
		name string
		m    Member
		c    Channel
		want Perms
	}{
		{"base is the OR of roles", Member{Roles: []Perms{ViewChannel, SendMessages}}, Channel{}, ViewChannel | SendMessages},
		{"owner gets everything", Member{IsOwner: true}, Channel{Everyone: Override{Deny: ViewChannel}}, All},
		{"admin role gets everything", Member{Roles: []Perms{0, Admin}}, Channel{Everyone: Override{Deny: ViewChannel}}, All},
		{"everyone deny removes", member, Channel{Everyone: Override{Deny: SendMessages}}, ViewChannel | ReadHistory},
		{"everyone allow adds", member, Channel{Everyone: Override{Allow: Stream}}, ViewChannel | SendMessages | ReadHistory | Stream},
		{"role allow beats everyone deny", member,
			Channel{Everyone: Override{Deny: SendMessages}, Roles: []Override{{Allow: SendMessages}}},
			ViewChannel | SendMessages | ReadHistory},
		{"role allow beats another role's deny", member,
			Channel{Roles: []Override{{Deny: SendMessages}, {Allow: SendMessages}}},
			ViewChannel | SendMessages | ReadHistory},
		{"member deny beats role allow", member,
			Channel{Roles: []Override{{Allow: Stream}}, Member: &Override{Deny: Stream | SendMessages}},
			ViewChannel | ReadHistory},
		{"member allow beats role deny", member,
			Channel{Roles: []Override{{Deny: SendMessages}}, Member: &Override{Allow: SendMessages}},
			ViewChannel | SendMessages | ReadHistory},
		{"no view means nothing", member, Channel{Everyone: Override{Deny: ViewChannel}}, 0},
		{"view granted by override", Member{Roles: []Perms{SendMessages}}, Channel{Roles: []Override{{Allow: ViewChannel}}}, ViewChannel | SendMessages},
		{"overrides cannot grant admin", member, Channel{Member: &Override{Allow: Admin}}, ViewChannel | SendMessages | ReadHistory},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Effective(tt.m, tt.c); got != tt.want {
				t.Fatalf("Effective = %b, want %b", got, tt.want)
			}
		})
	}
}

func TestBase(t *testing.T) {
	if got := Base(Member{Roles: []Perms{Kick, Ban}}); got != Kick|Ban {
		t.Fatalf("Base = %b", got)
	}
	if got := Base(Member{Roles: []Perms{Admin}}); got != All {
		t.Fatalf("admin Base = %b, want All", got)
	}
}

func TestHas(t *testing.T) {
	p := ViewChannel | SendMessages
	if !p.Has(ViewChannel) || !p.Has(ViewChannel|SendMessages) || p.Has(ViewChannel|Kick) {
		t.Fatal("Has is wrong")
	}
}

func TestBitValuesAreStable(t *testing.T) {
	// The web client mirrors these values (clients/core/src/perms.ts).
	if ViewChannel != 1 || Admin != 1<<16 || All != 1<<21-1 {
		t.Fatalf("flag values changed: view=%d admin=%d all=%d", ViewChannel, Admin, All)
	}
}

func TestNewFlags(t *testing.T) {
	require.Equal(t, Perms(1<<15), ManageServer)
	require.Equal(t, Perms(1<<17), AddReactions)
	require.Equal(t, Perms(1<<18), CreateThreads)
	require.Equal(t, Perms(1<<19), UseSoundboard)
	require.Equal(t, Perms(1<<20), ManageExpressions)
	require.Equal(t, Perms(1<<21-1), All)
	require.True(t, Default.Has(AddReactions|CreateThreads|UseSoundboard))
	require.False(t, Default.Has(ManageExpressions))
}
