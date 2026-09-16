package atomic

import (
	"testing"
	"time"
	"unsafe"
)

// In a 32-bit struct, a preceding word otherwise leaves these values unaligned.
func Test64BitAlignment(t *testing.T) {
	values := make([]struct {
		prefix uint32
		u      Uint64
		i      Int64
		f      Float64
		d      Duration
	}, 2)
	if unsafe.Sizeof(Uint64{}) != 8 || unsafe.Sizeof(Int64{}) != 8 {
		t.Fatal("alignment must not enlarge atomic values")
	}
	for n := range values {
		value := &values[n]
		if uintptr(unsafe.Pointer(&value.u))%8 != 0 || uintptr(unsafe.Pointer(&value.i))%8 != 0 {
			t.Fatal("64-bit atomics are not aligned")
		}
		value.u.Store(1)
		value.i.Store(-1)
		value.f.Store(1.5)
		value.d.Store(time.Second)
		if value.u.Add(1) != 2 || !value.i.CompareAndSwap(-1, -2) ||
			value.f.Load() != 1.5 || value.d.Load() != time.Second {
			t.Fatal("aligned atomic operations lost their values")
		}
	}
}
