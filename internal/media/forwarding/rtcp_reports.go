package forwarding

import (
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/report"
	"github.com/pion/rtp"
)

func configureRTCPReports(registry *interceptor.Registry) error {
	receiver, err := report.NewReceiverInterceptor()
	if err != nil {
		return err
	}
	sender, err := report.NewSenderInterceptor()
	if err != nil {
		return err
	}
	registry.Add(receiver)
	registry.Add(senderReportFactory{sender})
	return nil
}

type senderReportFactory struct{ interceptor.Factory }

func (factory senderReportFactory) NewInterceptor(id string) (interceptor.Interceptor, error) {
	sender, err := factory.Factory.NewInterceptor(id)
	if err != nil {
		return nil, err
	}
	return &senderReports{sender}, nil
}

type senderReports struct{ interceptor.Interceptor }

func (sender *senderReports) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	primary := sender.Interceptor.BindLocalStream(info, writer)
	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		// DownTrack sends RTX through the primary writer. Pion's SR interceptor
		// assumes one SSRC per writer; RTX probes use timestamp zero and must not
		// replace the primary RTP/NTP clock or enter its packet/octet counters.
		if header.SSRC != info.SSRC {
			return writer.Write(header, payload, attributes)
		}
		return primary.Write(header, payload, attributes)
	})
}
