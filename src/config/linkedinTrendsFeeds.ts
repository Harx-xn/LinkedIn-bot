// LinkedIn Hashtag Search Links Configuration
// Since these are not RSS, they are added as custom links for the AI to reference the general topic
export const LINKEDIN_HASHTAG_LINKS = {
    TECHNOLOGY: 'https://www.linkedin.com/feed/hashtag/?keywords=technology',
    MARKETING: 'https://www.linkedin.com/feed/hashtag/?keywords=marketing',
    ECONOMY: 'https://www.linkedin.com/feed/hashtag/?keywords=economy',
    CRYPTOCURRENCY: 'https://www.linkedin.com/feed/hashtag/?keywords=cryptocurrency',
    WEB3: 'https://www.linkedin.com/feed/hashtag/?keywords=web3',
    QUANTUM_COMPUTING: 'https://www.linkedin.com/feed/hashtag/?keywords=quantumcomputing',
};

export const LINKEDIN_PRESETS = {
    ALL: Object.values(LINKEDIN_HASHTAG_LINKS),
};
