// Package names turns an opaque peer ID into a stable, human-friendly label so
// users can tell each other apart without typing a nickname.
package names

import "hash/fnv"

var adjectives = []string{
	"Amber", "Azure", "Brave", "Bright", "Calm", "Clever", "Coral", "Crimson",
	"Eager", "Emerald", "Gentle", "Golden", "Happy", "Indigo", "Jolly", "Keen",
	"Lucky", "Mellow", "Nimble", "Olive", "Plucky", "Quiet", "Rapid", "Scarlet",
	"Silver", "Sunny", "Swift", "Teal", "Violet", "Witty",
}

var animals = []string{
	"Otter", "Falcon", "Badger", "Heron", "Lynx", "Marmot", "Puffin", "Raven",
	"Salmon", "Tapir", "Walrus", "Yak", "Ibex", "Koala", "Lemur", "Mantis",
	"Narwhal", "Ocelot", "Panda", "Quokka", "Rhino", "Seal", "Toucan", "Urchin",
	"Vulture", "Wombat", "Bison", "Cheetah", "Dingo", "Egret",
}

// FromID derives a deterministic "Swift Otter" style name from a peer ID, so a
// returning browser keeps the same name across reconnects.
func FromID(id string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(id))
	sum := h.Sum64()
	adj := adjectives[sum%uint64(len(adjectives))]
	animal := animals[(sum/uint64(len(adjectives)))%uint64(len(animals))]
	return adj + " " + animal
}
