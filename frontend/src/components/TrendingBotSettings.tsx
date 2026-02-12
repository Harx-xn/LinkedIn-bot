import React, { useState, useEffect, useRef, useContext } from 'react';
import { api } from '../api';
import { ToastContext } from '../App';

interface TrendingBotSettingsProps {
    onGenerationComplete?: () => void;
}

const TrendingBotSettings: React.FC<TrendingBotSettingsProps> = ({ onGenerationComplete }) => {
    const toast = useContext(ToastContext)!;
    const [niches, setNiches] = useState<string[]>([]);
    const [newNiche, setNewNiche] = useState('');

    const [sources, setSources] = useState<string[]>([]);
    const [backgroundImageUrl, setBackgroundImageUrl] = useState('');
    const [postsPerWeek, setPostsPerWeek] = useState(7);
    const [tone, setTone] = useState('Professional');
    const [customRssFeeds, setCustomRssFeeds] = useState<string[]>([]);
    const [customLinks, setCustomLinks] = useState<string[]>([]);
    const [customRedditFeeds, setCustomRedditFeeds] = useState<string[]>([]);
    const [newRss, setNewRss] = useState('');

    const [showPreview, setShowPreview] = useState(false);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewTrends, setPreviewTrends] = useState<any[]>([]);

    const [isEnabled, setIsEnabled] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [confirmGeneration, setConfirmGeneration] = useState(false);
    const [generationDuration, setGenerationDuration] = useState(7);

    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        loadConfig();
    }, []);

    useEffect(() => {
        if (showPreview) {
            fetchPreviewTrends();
        }
    }, [showPreview]);

    const fetchPreviewTrends = async () => {
        setPreviewLoading(true);
        try {
            await api.put('/bot/config', { niches, sources, customRssFeeds, customLinks, customRedditFeeds, backgroundImageUrl, postsPerWeek, tone, isEnabled });
            const res = await api.get('/bot/trends/preview');
            setPreviewTrends(res.data);
        } catch (err) {
            toast.error('Failed to fetch trends preview');
        } finally {
            setPreviewLoading(false);
        }
    };

    const loadConfig = async () => {
        setLoading(true);
        try {
            const res = await api.get('/bot/config');
            const data = res.data;

            let parsedNiches = [];
            try { parsedNiches = JSON.parse(data.niches); } catch { }
            if (!Array.isArray(parsedNiches)) parsedNiches = data.niches ? [data.niches] : [];

            let parsedSources = [];
            try { parsedSources = JSON.parse(data.sources); } catch { }
            let parsedRss = [];
            try { parsedRss = JSON.parse(data.customRssFeeds); } catch { }
            let parsedLinks = [];
            try { parsedLinks = JSON.parse(data.customLinks); } catch { }
            let parsedReddit = [];
            try { parsedReddit = JSON.parse(data.customRedditFeeds); } catch { }

            setNiches(parsedNiches);
            setSources(parsedSources);
            setCustomRssFeeds(parsedRss);
            setCustomLinks(parsedLinks);
            setCustomRedditFeeds(parsedReddit);
            setBackgroundImageUrl(data.backgroundImageUrl || '');
            setPostsPerWeek(data.postsPerWeek || 7);
            setTone(data.tone || 'Professional');
            setIsEnabled(data.isEnabled);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsUploading(true);
        const formData = new FormData();
        formData.append('image', file);

        try {
            const res = await api.post('/upload', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });
            setBackgroundImageUrl(res.data.url);
        } catch (err) {
            toast.error('Failed to upload image');
        } finally {
            setIsUploading(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        console.log("check")
        try {
            await api.put('/bot/config', {
                niches,
                sources,
                customRssFeeds,
                customLinks,
                customRedditFeeds,
                backgroundImageUrl,
                postsPerWeek,
                tone,
                isEnabled
            });
            toast.success('Configuration saved successfully!');
        } catch (err) {
            toast.error('Failed to save settings');
        } finally {
            setSaving(false);
        }
    };

    const handleGenerate = async (days: number) => {
        // Validate configuration before generating
        if (niches.length === 0) {
            toast.warning('Please add at least one niche before generating posts.');
            return;
        }

        if (sources.length === 0) {
            toast.warning('Please select at least one trend source before generating posts.');
            return;
        }

        if (!confirmGeneration) {
            setConfirmGeneration(true);
            setTimeout(() => setConfirmGeneration(false), 5000); // Reset after 5s
            return;
        }

        setGenerating(true);
        setConfirmGeneration(false);
        try {
            // Save config first to ensure latest is used
            await api.put('/bot/config', { niches, sources, customRssFeeds, customLinks, customRedditFeeds, backgroundImageUrl, postsPerWeek, tone, isEnabled: true });

            await api.post('/bot/generate', { daysWindow: days });
            toast.success('Batch generation complete!');

            if (onGenerationComplete) {
                onGenerationComplete();
            }
        } catch (err: any) {
            console.error('Generation error:', err);
            const errorMsg = err.response?.data?.error || 'Generation failed. Please check the console.';
            toast.error(errorMsg);
        } finally {
            setGenerating(false);
        }
    };

    const addNiche = (e: React.FormEvent) => {
        e.preventDefault();
        if (newNiche && !niches.includes(newNiche)) {
            setNiches([...niches, newNiche]);
            setNewNiche('');
        }
    };

    const removeNiche = (nicheToRemove: string) => {
        setNiches(niches.filter(n => n !== nicheToRemove));
    };

    const toggleSource = (source: string) => {
        if (sources.includes(source)) {
            setSources(sources.filter(s => s !== source));
        } else {
            setSources([...sources, source]);
        }
    };

    if (loading) return <div className="loading">Loading configuration...</div>;

    return (
        <div className="card automation-card" style={{ position: 'relative' }}>
            {generating && (
                <div className="processing-overlay">
                    <div className="spinner-container">
                        <div className="spinner"></div>
                        <h3>Generating Content...</h3>
                        <p>We are searching trends and crafting your posts with AI. This may take a minute.</p>
                    </div>
                </div>
            )}

            <div className="card-header-toggle">
                <div className="header-text">
                    <h2>Trending Bot Automation</h2>
                    <p>Configure how the bot finds topics and creates content.</p>
                </div>
                <label className="switch">
                    <input type="checkbox" checked={isEnabled} onChange={e => setIsEnabled(e.target.checked)} />
                    <span className="slider round"></span>
                </label>
            </div>

            <div className={`automation-content ${!isEnabled ? 'disabled' : ''}`}>

                <div className="form-group">
                    <h3>Target Niches</h3>
                    <div className="tags-container">
                        {niches.map(niche => (
                            <span key={niche} className="tag-chip">
                                {niche}
                                <button onClick={() => removeNiche(niche)}>&times;</button>
                            </span>
                        ))}
                    </div>
                    <form onSubmit={addNiche} className="add-niche-form">
                        <input
                            type="text"
                            value={newNiche}
                            onChange={e => setNewNiche(e.target.value)}
                            placeholder="Add a niche (e.g. AI, Crypto)"
                            className="form-input"
                        />
                        <button type="submit" className="btn btn-secondary">Add</button>
                    </form>
                </div>

                <div className="form-group">
                    <h3>Trend Sources</h3>
                    <div className="checkbox-group">
                        {['reddit', 'medium', 'google', 'linkedin'].map(source => (
                            <label key={source} className={`checkbox-card ${sources.includes(source) ? 'active' : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={sources.includes(source)}
                                    onChange={() => toggleSource(source)}
                                />
                                <span className="source-name">{source.charAt(0).toUpperCase() + source.slice(1)}</span>
                            </label>
                        ))}
                    </div>

                    <div style={{ marginTop: '1rem' }}>
                        <label className="form-label">Custom RSS Feeds (Optional)</label>
                        <div className="tags-container">
                            {customRssFeeds.map(rss => (
                                <div key={rss} className="tag-chip" style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {rss}
                                    <button onClick={() => setCustomRssFeeds(customRssFeeds.filter(r => r !== rss))}>&times;</button>
                                </div>
                            ))}
                        </div>
                        <div className="add-niche-form">
                            <input
                                type="url"
                                value={newRss}
                                onChange={e => setNewRss(e.target.value)}
                                placeholder="https://example.com/feed.xml"
                                className="form-input"
                            />
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => {
                                    if (newRss && !customRssFeeds.includes(newRss)) {
                                        setCustomRssFeeds([...customRssFeeds, newRss]);
                                        setNewRss('');
                                    }
                                }}
                            >
                                Add
                            </button>
                        </div>
                    </div>
                </div>

                <div className="form-group">
                    <h3>Schedule & Frequency</h3>
                    <label className="form-label">
                        Posts per Week: <strong>{postsPerWeek}</strong>
                    </label>
                    <input
                        type="range"
                        min="1" max="21"
                        value={postsPerWeek}
                        onChange={e => setPostsPerWeek(parseInt(e.target.value))}
                        className="range-input"
                        style={{ width: '100%', accentColor: 'var(--primary)' }}
                    />
                    <p className="hint">The bot will distribute {postsPerWeek} posts evenly throughout the week.</p>
                </div>

                <div className="form-group">
                    <h3>Post Appearance</h3>

                    <label className="form-label">Tone & Style</label>
                    <select
                        className="form-input"
                        value={tone}
                        onChange={e => setTone(e.target.value)}
                        style={{ background: '#0f172a', color: 'white', border: '1px solid rgba(255,255,255,0.1)', marginBottom: '1rem' }}
                    >
                        <option value="Professional">Professional (Default)</option>
                        <option value="Casual">Casual & Conversational</option>
                        <option value="Humorous">Humorous & Witty</option>
                        <option value="Data-Driven">Data-Driven & Analytical</option>
                        <option value="Controversial">Bold & Controversial</option>
                        <option value="Educational">Educational & Instructional</option>
                    </select>

                    <label className="form-label">Background Image</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.5rem' }}>
                        <input
                            type="file"
                            accept="image/*"
                            ref={fileInputRef}
                            onChange={handleFileChange}
                            style={{ color: '#94a3b8' }}
                        />
                        {isUploading && <span style={{ color: '#94a3b8' }}>Uploading...</span>}
                    </div>

                    {backgroundImageUrl && (
                        <div className="image-preview" style={{ backgroundImage: `url(http://localhost:4000/${backgroundImageUrl})` }}>
                            <button
                                type="button"
                                onClick={() => { setBackgroundImageUrl(''); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                                style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,0.6)', color: 'white', border: 'none', borderRadius: '50%', width: 24, height: 24, cursor: 'pointer' }}
                            >
                                &times;
                            </button>
                        </div>
                    )}
                </div>

                <div className="btn-row" style={{ display: 'flex', gap: '1rem', marginTop: '2rem' }}>
                    <button className="btn btn-primary full-width" onClick={handleSave} disabled={saving || isUploading}>
                        {saving ? 'Saving...' : 'Save Configuration'}
                    </button>
                </div>

                <hr style={{ borderColor: 'var(--border)', margin: '2rem 0' }} />

                <div className="form-group">
                    <h3>Batch Generation</h3>
                    <p className="hint">Generate a schedule of posts right now based on your configuration.</p>

                    <div style={{ marginBottom: '1rem' }}>
                        <label className="form-label">Duration</label>
                        <select
                            className="form-input"
                            value={generationDuration}
                            onChange={e => setGenerationDuration(parseInt(e.target.value))}
                            style={{ background: '#0f172a', color: 'white', border: '1px solid rgba(255,255,255,0.1)' }}
                        >
                            <option value={7}>Next 7 Days (1 Week)</option>
                            <option value={30}>Next 30 Days (1 Month)</option>
                            <option value={90}>Next 90 Days (3 Months)</option>
                            <option value={180}>Next 180 Days (6 Months)</option>
                        </select>
                    </div>

                    <div className="btn-row" style={{ display: 'flex', gap: '1rem' }}>
                        <button className={`btn full-width ${confirmGeneration ? 'btn-danger' : 'btn-secondary'}`} onClick={() => handleGenerate(generationDuration)} disabled={generating}>
                            {generating ? 'Generating...' : confirmGeneration ? 'Click Again to Confirm' : `Generate Schedule`}
                        </button>
                    </div>

                    <div style={{ marginTop: '1rem' }}>
                        <button className="btn btn-outline full-width" onClick={() => setShowPreview(true)}>
                            👁 Preview Found Trends
                        </button>
                    </div>
                </div>

            </div>

            {showPreview && (
                <div className="modal-overlay">
                    <div className="modal-content" style={{ width: '600px', maxHeight: '80vh', overflowY: 'auto' }}>
                        <h2>Current Top Trends</h2>
                        <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>Based on your selected niches and sources.</p>

                        {previewLoading ? (
                            <div className="loading">Fetching trends...</div>
                        ) : (
                            <div className="trends-list" style={{ marginTop: '1rem' }}>
                                {previewTrends.length === 0 ? (
                                    <p>No trends found right now. Check your niches and sources.</p>
                                ) : (
                                    previewTrends.map((trend, i) => (
                                        <div key={i} style={{ background: 'rgba(255,255,255,0.05)', padding: '0.8rem', borderRadius: '8px', marginBottom: '0.5rem' }}>
                                            <a href={trend.link} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', fontWeight: 'bold', textDecoration: 'none' }}>
                                                {trend.title}
                                            </a>
                                            <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.8rem', color: '#94a3b8', marginTop: '0.3rem' }}>
                                                <span>{trend.source}</span>
                                                <span>•</span>
                                                <span>{new Date(trend.pubDate).toLocaleDateString()}</span>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                        <button className="btn btn-secondary" style={{ marginTop: '1rem', width: '100%' }} onClick={() => setShowPreview(false)}>Close</button>
                    </div>
                </div>
            )}
        </div>
    );
};
export default TrendingBotSettings;
