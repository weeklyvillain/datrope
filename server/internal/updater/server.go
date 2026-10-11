package updater

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"time"
)

type Lister interface {
	Containers(ctx context.Context, project string) ([]ContainerInfo, error)
}

// Server is the updater's HTTP API. Only the Datrope server calls it, with the shared token.
type Server struct {
	Token   string
	Git     *Git
	Jobs    *Jobs
	Docker  Lister
	Compose Compose
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, s.Git.Status())
	})
	mux.HandleFunc("POST /check", func(w http.ResponseWriter, r *http.Request) {
		// A client hanging up must not kill git mid-fetch: that leaves stale .lock files.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Minute)
		defer cancel()
		writeJSON(w, http.StatusOK, s.Git.Check(ctx))
	})
	mux.HandleFunc("POST /update", func(w http.ResponseWriter, r *http.Request) {
		steps, final := UpdateSteps(s.Git, s.Compose)
		id, err := s.Jobs.Start(steps, final)
		switch {
		case errors.Is(err, ErrBusy):
			writeErr(w, http.StatusConflict, err.Error())
		case err != nil:
			writeErr(w, http.StatusInternalServerError, err.Error())
		default:
			writeJSON(w, http.StatusAccepted, map[string]string{"job_id": id})
		}
	})
	mux.HandleFunc("GET /jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		after, _ := strconv.Atoi(r.URL.Query().Get("after"))
		log, err := s.Jobs.Log(r.PathValue("id"), after)
		if err != nil {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, log)
	})
	mux.HandleFunc("GET /containers", func(w http.ResponseWriter, r *http.Request) {
		cs, err := s.Docker.Containers(r.Context(), s.Compose.Project)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, cs)
	})
	mux.HandleFunc("POST /containers/{service}/restart", func(w http.ResponseWriter, r *http.Request) {
		svc := r.PathValue("service")
		cs, err := s.Docker.Containers(r.Context(), s.Compose.Project)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		known := slices.ContainsFunc(cs, func(c ContainerInfo) bool { return c.Service == svc })
		if !known || svc == "updater" {
			writeErr(w, http.StatusNotFound, "no such service")
			return
		}
		// Restarting the server drops the caller's connection, which cancels r.Context(); the
		// restart must still finish, or it could leave the service stopped.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
		defer cancel()
		var out bytes.Buffer
		if err := s.Compose.cmd(ctx, &out, "restart", svc); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error()+": "+out.String())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	return s.auth(mux)
}

func (s *Server) auth(next http.Handler) http.Handler {
	want := []byte("Bearer " + s.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			writeErr(w, http.StatusUnauthorized, "bad token")
			return
		}
		next.ServeHTTP(w, r)
	})
}
