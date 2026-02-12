import React, { useState, useRef, useContext } from 'react';
import { api } from '../api';
import { ToastContext } from '../App';

interface CreatePostFormProps {
    onPostCreated: () => void;
}

const CreatePostForm: React.FC<CreatePostFormProps> = ({ onPostCreated }) => {
    const toast = useContext(ToastContext)!;
    const [content, setContent] = useState('');
    const [scheduledAt, setScheduledAt] = useState('');
    const [backgroundImageUrl, setBackgroundImageUrl] = useState('');
    const [isUploading, setIsUploading] = useState(false);
    const [loading, setLoading] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);

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
            console.error(err);
            toast.error('Failed to upload image');
        } finally {
            setIsUploading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const body: any = { content, source: 'MANUAL', backgroundImageUrl };
            if (scheduledAt) body.scheduledAt = new Date(scheduledAt).toISOString();

            await api.post('/posts', body);
            setContent('');
            setScheduledAt('');
            setBackgroundImageUrl('');
            if (fileInputRef.current) fileInputRef.current.value = '';
            onPostCreated();
            toast.success('Post created successfully!');
        } catch (err) {
            console.error(err);
            toast.error('Failed to create post');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="card create-post-card">
            <h2>Create New Post</h2>
            <form onSubmit={handleSubmit}>
                <textarea
                    className="form-textarea"
                    placeholder="What's on your mind? (Markdown supported)"
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    required
                />

                <div className="form-group mt-4" style={{ marginBottom: '1rem' }}>
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
                        <div className="image-preview-mini" style={{
                            backgroundImage: `url(http://localhost:3000/${backgroundImageUrl})`,
                            height: '100px',
                            marginTop: '0.8rem',
                            borderRadius: '8px',
                            backgroundSize: 'cover',
                            border: '1px solid rgba(255,255,255,0.1)',
                            position: 'relative'
                        }}>
                            <button
                                type="button"
                                onClick={() => { setBackgroundImageUrl(''); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                                style={{ position: 'absolute', top: 5, right: 5, background: 'rgba(0,0,0,0.6)', color: 'white', border: 'none', borderRadius: '50%', width: 24, height: 24, cursor: 'pointer' }}
                            >
                                &times;
                            </button>
                        </div>
                    )}
                </div>

                <div className="form-actions">
                    <div style={{ flex: 1 }}>
                        <label className="form-label" style={{ marginBottom: '0.5rem', display: 'block' }}>Schedule For</label>
                        <input
                            type="datetime-local"
                            className="form-input date-input"
                            value={scheduledAt}
                            onChange={e => setScheduledAt(e.target.value)}
                            min={new Date().toISOString().slice(0, 16)}
                            style={{ width: '100%' }}
                        />
                    </div>
                    <button type="submit" className="btn btn-primary" disabled={loading || isUploading} style={{ alignSelf: 'flex-end' }}>
                        {loading ? 'Creating...' : scheduledAt ? 'Schedule Post' : 'Post Now'}
                    </button>
                </div>
            </form>
        </div>
    );
};

export default CreatePostForm;
