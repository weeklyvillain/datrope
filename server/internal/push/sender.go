package push

import (
	"context"
	"io"
	"net/http"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// Sender delivers one encrypted push message. status is the push service's
// HTTP status (0 when the request never got a response).
type Sender interface {
	Send(ctx context.Context, sub Subscription, payload []byte, urgent bool) (status int, err error)
}

// pushClient does not follow redirects, so a push service cannot bounce the request to another host.
var pushClient = &http.Client{
	Timeout:       sendLimit,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

type webpushSender struct {
	keys       func(ctx context.Context) (vapidKeys, error)
	subscriber string // the instance's public URL, sent to push services as the VAPID contact
}

func (w webpushSender) Send(ctx context.Context, sub Subscription, payload []byte, urgent bool) (int, error) {
	k, err := w.keys(ctx)
	if err != nil {
		return 0, err
	}
	urgency := webpush.UrgencyNormal
	if urgent {
		urgency = webpush.UrgencyHigh
	}
	res, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys:     webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
	}, &webpush.Options{
		HTTPClient:      pushClient,
		Subscriber:      w.subscriber,
		VAPIDPublicKey:  k.public,
		VAPIDPrivateKey: k.private,
		TTL:             int((24 * time.Hour).Seconds()),
		Urgency:         urgency,
	})
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	return res.StatusCode, nil
}

// gone reports whether the push service says the subscription no longer exists.
func gone(status int) bool { return status == http.StatusNotFound || status == http.StatusGone }
