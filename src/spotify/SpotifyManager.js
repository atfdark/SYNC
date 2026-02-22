/**
 * SpotifyManager – polls Spotify's "currently playing" API
 * and emits events so the UI can react to what's playing.
 *
 * No Web Playback SDK needed – the user just plays music
 * normally on any Spotify device (phone, desktop app, etc.)
 * and SyncPlay detects it automatically.
 */

class SpotifyManager extends EventTarget {
    constructor() {
        super();
        this.accessToken = null;
        this.currentTrack = null;
        this.isPlaying = false;
        this._pollTimer = null;
        this._refreshTimer = null;
        this._destroyed = false;
        this.POLL_MS = 3000; // poll every 3 seconds
    }

    // ── Public API ─────────────────────────────────────────────────────────

    async init() {
        await this._fetchToken();
        this._startPolling();
    }

    destroy() {
        this._destroyed = true;
        if (this._pollTimer) clearInterval(this._pollTimer);
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
    }

    static async isLoggedIn() {
        try {
            const res = await fetch('/api/token');
            return res.ok;
        } catch { return false; }
    }

    /** Toggle play / pause on the active Spotify device */
    async togglePlayPause() {
        const endpoint = this.isPlaying ? '/api/pause' : '/api/play';
        try {
            await fetch(endpoint, { method: 'PUT' });
            // Give Spotify a moment then re-poll immediately
            setTimeout(() => this._poll(), 500);
        } catch (e) { /* ignore */ }
    }

    /** Skip to next track */
    async skipToNext() {
        try {
            await fetch('/api/next', { method: 'POST' });
            setTimeout(() => this._poll(), 500);
        } catch (e) { /* ignore */ }
    }

    /** Skip to previous track */
    async skipToPrevious() {
        try {
            await fetch('/api/previous', { method: 'POST' });
            setTimeout(() => this._poll(), 500);
        } catch (e) { /* ignore */ }
    }

    // ── Internal ───────────────────────────────────────────────────────────

    async _fetchToken() {
        const res = await fetch('/api/token');
        if (!res.ok) throw new Error('Not logged in to Spotify');
        const data = await res.json();
        this.accessToken = data.access_token;
        // Schedule token refresh 60s before expiry
        const refreshIn = Math.max(0, (data.expires_in - 60)) * 1000;
        if (refreshIn > 0) {
            this._refreshTimer = setTimeout(() => this._refreshToken(), refreshIn);
        }
    }

    async _refreshToken() {
        try {
            const res = await fetch('/api/refresh');
            if (res.ok) {
                const data = await res.json();
                this.accessToken = data.access_token;
                const refreshIn = Math.max(0, (data.expires_in - 60)) * 1000;
                if (refreshIn > 0 && !this._destroyed) {
                    this._refreshTimer = setTimeout(() => this._refreshToken(), refreshIn);
                }
            }
        } catch (e) { /* silently retry next poll */ }
    }

    _startPolling() {
        this._poll(); // immediate first poll
        this._pollTimer = setInterval(() => this._poll(), this.POLL_MS);
    }

    async _poll() {
        if (this._destroyed || !this.accessToken) return;
        try {
            const res = await fetch('/api/currently-playing');
            if (res.status === 204) {
                // Nothing playing
                if (this.currentTrack !== null || this.isPlaying) {
                    this.currentTrack = null;
                    this.isPlaying = false;
                    this._emit('stateChanged', { track: null, isPlaying: false });
                }
                return;
            }
            if (res.status === 401) {
                await this._fetchToken();
                return;
            }
            if (!res.ok) return;

            const data = await res.json();
            if (!data || !data.item) return;

            const track = {
                name: data.item.name,
                uri: data.item.uri,
                artists: data.item.artists,
                album: data.item.album,
                duration_ms: data.item.duration_ms,
                progress_ms: data.progress_ms,
            };

            const changed =
                this.isPlaying !== data.is_playing ||
                this.currentTrack?.uri !== track.uri;

            this.currentTrack = track;
            this.isPlaying = data.is_playing;

            if (changed) {
                this._emit('stateChanged', {
                    track,
                    isPlaying: data.is_playing,
                    progress_ms: data.progress_ms,
                    device: data.device || null,
                });
            }
        } catch (e) { /* network hiccup — retry next interval */ }
    }

    _emit(name, detail) {
        this.dispatchEvent(new CustomEvent(name, { detail }));
    }
}

export { SpotifyManager };
