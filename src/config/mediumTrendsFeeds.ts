// Medium Tag RSS Feeds Configuration
export const MEDIUM_TAG_FEEDS = {
    TECHNOLOGY: 'https://medium.com/feed/tag/technology',
    BUSINESS: 'https://medium.com/feed/tag/business',
    MARKETING: 'https://medium.com/feed/tag/marketing',
    ECONOMICS: 'https://medium.com/feed/tag/economics',
    CRYPTOCURRENCY: 'https://medium.com/feed/tag/cryptocurrency',
    WEB3: 'https://medium.com/feed/tag/web3',
    QUANTUM_COMPUTING: 'https://medium.com/feed/tag/quantum-computing',
    BLOCKCHAIN: 'https://medium.com/feed/tag/blockchain',
};

export const MEDIUM_PRESETS = {
    ALL: Object.values(MEDIUM_TAG_FEEDS),
    CORE_TECH: [
        MEDIUM_TAG_FEEDS.TECHNOLOGY,
        MEDIUM_TAG_FEEDS.WEB3,
        MEDIUM_TAG_FEEDS.BLOCKCHAIN,
        MEDIUM_TAG_FEEDS.QUANTUM_COMPUTING,
    ],
    BUSINESS: [
        MEDIUM_TAG_FEEDS.BUSINESS,
        MEDIUM_TAG_FEEDS.MARKETING,
        MEDIUM_TAG_FEEDS.ECONOMICS,
    ],
};
