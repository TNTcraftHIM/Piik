package fanoutoracle

import (
	"bytes"
	"context"
	"testing"
	"time"
)

func TestOneRTPWriteFansOutAcrossIndependentTransports(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	result, err := Run(ctx)
	if err != nil {
		t.Fatal(err)
	}

	if result.SourceWrites != 1 {
		t.Fatalf("source writes = %d, want 1", result.SourceWrites)
	}
	if result.SourceSSRC != oracleSourceSSRC {
		t.Fatalf("source SSRC = %d, want %d", result.SourceSSRC, oracleSourceSSRC)
	}
	if !result.PayloadsEqual {
		t.Fatal("downstream semantic payloads differ")
	}
	if !result.IndependentSSRC {
		t.Fatal("downstream SSRCs are not independent")
	}
	if result.Downstream[0].SSRC == result.SourceSSRC || result.Downstream[1].SSRC == result.SourceSSRC {
		t.Fatal("a transport failed to rewrite the source SSRC")
	}
	for index, downstream := range result.Downstream {
		if downstream.SequenceNumber != oracleSequenceNumber {
			t.Errorf("downstream %d sequence number = %d, want %d", index+1, downstream.SequenceNumber, oracleSequenceNumber)
		}
		if downstream.Timestamp != oracleTimestamp {
			t.Errorf("downstream %d timestamp = %d, want %d", index+1, downstream.Timestamp, oracleTimestamp)
		}
		if !bytes.Equal(downstream.Payload, oraclePayload) {
			t.Errorf("downstream %d payload differs from source", index+1)
		}
	}
}
