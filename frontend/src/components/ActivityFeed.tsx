import React, { useContext, useState } from 'react';
import { api } from '../api';
import { ToastContext } from '../App';

interface Post {
    id: string;
    content: string;
    scheduledAt: string | null;
    status: string;
    source: string;
    mediaUrl?: string;
    errorMessage?: string;
}

interface ActivityFeedProps {
    posts: Post[];
    loading: boolean;
    onRefresh: () => void;
    filter?: 'all' | 'manual' | 'bot' | 'scheduled' | 'published';
}

const ActivityFeed: React.FC<ActivityFeedProps> = ({ posts, loading, onRefresh, filter = 'all' }) => {
    const toast = useContext(ToastContext)!;
    const [currentPage, setCurrentPage] = useState(1);
    const [expandedPosts, setExpandedPosts] = useState<Set<string>>(new Set());
    const postsPerPage = 5;

    const [confirmPublishId, setConfirmPublishId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    const handlePublish = async (id: string) => {
        if (confirmPublishId !== id) {
            setConfirmPublishId(id);
            setTimeout(() => setConfirmPublishId(null), 3000);
            return;
        }

        try {
            await api.post(`/posts/${id}/publish`);
            toast.success('Post published successfully!');
            setConfirmPublishId(null);
            onRefresh();
        } catch (err: any) {
            const errorMsg = err.response?.data?.error || 'Failed to publish post';
            toast.error(errorMsg);
        }
    };

    const handleDelete = async (id: string) => {
        if (confirmDeleteId !== id) {
            setConfirmDeleteId(id);
            setTimeout(() => setConfirmDeleteId(null), 3000);
            return;
        }

        try {
            await api.delete(`/posts/${id}`);
            toast.success('Post deleted successfully!');
            setConfirmDeleteId(null);
            onRefresh();
        } catch (err: any) {
            const errorMsg = err.response?.data?.error || 'Failed to delete post';
            toast.error(errorMsg);
        }
    };

    const toggleExpanded = (postId: string) => {
        setExpandedPosts(prev => {
            const newSet = new Set(prev);
            if (newSet.has(postId)) {
                newSet.delete(postId);
            } else {
                newSet.add(postId);
            }
            return newSet;
        });
    };

    // Filter posts based on source and status
    const filteredPosts = posts.filter(post => {
        // Published tab: show ALL published posts regardless of source
        if (filter === 'published') return post.status === 'PUBLISHED';

        // Scheduled tab: show all non-published posts
        if (filter === 'scheduled') return post.status === 'QUEUED' || post.status === 'DRAFT';

        // Manual tab: show only SCHEDULED manual posts (exclude published)
        if (filter === 'manual') {
            return (post.source === 'MANUAL' || post.source === 'GOOGLE_SHEET') &&
                post.status !== 'PUBLISHED';
        }

        // Bot tab: show only SCHEDULED bot posts (exclude published)
        if (filter === 'bot') {
            return (post.source === 'AI' || post.source === 'AI_TRENDING') &&
                post.status !== 'PUBLISHED';
        }

        // All tab: show everything
        if (filter === 'all') return true;

        return true;
    });

    // Pagination logic
    const totalPages = Math.ceil(filteredPosts.length / postsPerPage);
    const startIndex = (currentPage - 1) * postsPerPage;
    const endIndex = startIndex + postsPerPage;
    const currentPosts = filteredPosts.slice(startIndex, endIndex);

    // Reset to page 1 when filter changes
    React.useEffect(() => {
        setCurrentPage(1);
    }, [filter]);

    const handlePageChange = (page: number) => {
        setCurrentPage(page);
    };

    return (
        <div className="card feed-card">
            <div className="card-header">
                <h2>Activity Feed</h2>
                <button className="btn btn-icon" onClick={onRefresh} disabled={loading}>
                    ↻
                </button>
            </div>

            {filteredPosts.length === 0 ? (
                <div className="empty-state">
                    {filter === 'manual' && 'No scheduled manual posts. All manual posts have been published or there are none yet.'}
                    {filter === 'bot' && 'No scheduled bot posts. All bot posts have been published or there are none yet.'}
                    {filter === 'scheduled' && 'No scheduled posts. All posts have been published or there are no posts yet.'}
                    {filter === 'published' && 'No published posts yet. Publish a post to see it here!'}
                    {filter === 'all' && 'No activity yet. Create a post or wait for the bot!'}
                </div>
            ) : (
                <>
                    <div className="feed-list">
                        {currentPosts.map(post => {
                            const isExpanded = expandedPosts.has(post.id);
                            const shouldTruncate = post.content.length > 200;
                            const displayContent = isExpanded || !shouldTruncate
                                ? post.content
                                : post.content.slice(0, 200) + '...';

                            return (
                                <div key={post.id} className="feed-item">
                                    <div className="feed-content">
                                        <div className="feed-meta">
                                            <span className={`badge badge-${post.status.toLowerCase()}`}>{post.status}</span>
                                            <span className="source-tag">{post.source}</span>
                                            {post.scheduledAt && <span className="date">{new Date(post.scheduledAt).toLocaleString()}</span>}
                                        </div>

                                        <div className="post-content-preview">
                                            <p style={{ whiteSpace: 'pre-wrap', margin: '0.8rem 0' }}>{displayContent}</p>
                                            {shouldTruncate && (
                                                <button
                                                    className="btn-link"
                                                    onClick={() => toggleExpanded(post.id)}
                                                    style={{
                                                        color: 'var(--primary)',
                                                        background: 'none',
                                                        border: 'none',
                                                        cursor: 'pointer',
                                                        fontSize: '0.9rem',
                                                        fontWeight: '600',
                                                        padding: '0'
                                                    }}
                                                >
                                                    {isExpanded ? 'Read Less' : 'Read More'}
                                                </button>
                                            )}
                                        </div>

                                        {post.status === 'FAILED' && post.errorMessage && (
                                            <div style={{
                                                marginTop: '0.5rem',
                                                padding: '0.5rem',
                                                background: 'rgba(239, 68, 68, 0.1)',
                                                borderLeft: '3px solid #ef4444',
                                                borderRadius: '4px',
                                                fontSize: '0.85rem',
                                                color: '#f87171'
                                            }}>
                                                <strong>Error:</strong> {post.errorMessage}
                                            </div>
                                        )}

                                        {/* Show image only when expanded or for short posts */}
                                        {(isExpanded || !shouldTruncate) && post.mediaUrl && (
                                            <div style={{ marginTop: '1rem' }}>
                                                <img
                                                    src={`http://localhost:4000/${post.mediaUrl.split(/[\\\/]/).pop()}`}
                                                    alt="Post preview"
                                                    style={{
                                                        maxWidth: '100%',
                                                        height: 'auto',
                                                        borderRadius: '8px',
                                                        border: '1px solid rgba(255,255,255,0.1)',
                                                        display: 'block'
                                                    }}
                                                    onError={(e) => {
                                                        console.error('Image failed to load:', post.mediaUrl);
                                                        e.currentTarget.style.display = 'none';
                                                    }}
                                                />
                                            </div>
                                        )}
                                    </div>
                                    <div className="feed-actions">
                                        {post.status !== 'PUBLISHED' && (
                                            <>
                                                <button className={`btn btn-sm ${confirmPublishId === post.id ? 'btn-primary' : 'btn-outline'}`} onClick={() => handlePublish(post.id)}>
                                                    {confirmPublishId === post.id ? 'Confirm?' : (post.status === 'FAILED' ? 'Retry' : 'Publish')}
                                                </button>
                                                <button className={`btn btn-sm ${confirmDeleteId === post.id ? 'btn-danger' : 'btn-outline'}`} onClick={() => handleDelete(post.id)} style={confirmDeleteId === post.id ? { color: 'white', background: 'var(--error)' } : {}}>
                                                    {confirmDeleteId === post.id ? 'Delete?' : 'Delete'}
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Pagination Controls */}
                    {totalPages > 1 && (
                        <div className="pagination">
                            <button
                                className="btn btn-sm btn-outline"
                                onClick={() => handlePageChange(currentPage - 1)}
                                disabled={currentPage === 1}
                            >
                                Previous
                            </button>

                            <div className="pagination-info">
                                Page {currentPage} of {totalPages}
                            </div>

                            <button
                                className="btn btn-sm btn-outline"
                                onClick={() => handlePageChange(currentPage + 1)}
                                disabled={currentPage === totalPages}
                            >
                                Next
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default ActivityFeed;
