package forwarding

import "github.com/pion/transport/v5/packetio"

// packetBuffer adapts Pion's bounded packet queue to its SRTP BufferFactory's
// io.ReadWriteCloser contract, retaining optional packet attributes.
type packetBuffer struct {
	*packetio.Buffer
}

func (buffer *packetBuffer) Read(payload []byte) (int, error) {
	n, _, err := buffer.Buffer.Read(payload, nil)
	return n, err
}

func (buffer *packetBuffer) Write(payload []byte) (int, error) {
	return buffer.Buffer.Write(payload, nil)
}

func (buffer *packetBuffer) ReadWithAttributes(payload []byte, attributes packetio.Attributes) (int, packetio.Attributes, error) {
	return buffer.Buffer.Read(payload, attributes)
}

func (buffer *packetBuffer) WriteWithAttributes(payload []byte, attributes packetio.Attributes) (int, error) {
	return buffer.Buffer.Write(payload, attributes)
}
