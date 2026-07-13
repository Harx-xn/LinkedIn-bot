// Google Trends RSS Feeds Configuration
// These feeds are used internally as Google Trends sources.

export const GOOGLE_TRENDS_FEEDS = {
    // United States
    US: 'https://trends.google.com/trending/rss?geo=US',

    // Europe
    GB: 'https://trends.google.com/trending/rss?geo=GB', // United Kingdom
    DE: 'https://trends.google.com/trending/rss?geo=DE', // Germany
    FR: 'https://trends.google.com/trending/rss?geo=FR', // France
    IT: 'https://trends.google.com/trending/rss?geo=IT', // Italy
    ES: 'https://trends.google.com/trending/rss?geo=ES', // Spain
    NL: 'https://trends.google.com/trending/rss?geo=NL', // Netherlands
    SE: 'https://trends.google.com/trending/rss?geo=SE', // Sweden
    NO: 'https://trends.google.com/trending/rss?geo=NO', // Norway
    DK: 'https://trends.google.com/trending/rss?geo=DK', // Denmark
    FI: 'https://trends.google.com/trending/rss?geo=FI', // Finland
    PL: 'https://trends.google.com/trending/rss?geo=PL', // Poland

    // Gulf (GCC)
    AE: 'https://trends.google.com/trending/rss?geo=AE', // UAE
    SA: 'https://trends.google.com/trending/rss?geo=SA', // Saudi Arabia
    QA: 'https://trends.google.com/trending/rss?geo=QA', // Qatar
    KW: 'https://trends.google.com/trending/rss?geo=KW', // Kuwait
    OM: 'https://trends.google.com/trending/rss?geo=OM', // Oman
    BH: 'https://trends.google.com/trending/rss?geo=BH', // Bahrain
};

// Regional feed collections
const EUROPE_FEEDS = [
    GOOGLE_TRENDS_FEEDS.GB,
    GOOGLE_TRENDS_FEEDS.DE,
    GOOGLE_TRENDS_FEEDS.FR,
    GOOGLE_TRENDS_FEEDS.IT,
    GOOGLE_TRENDS_FEEDS.ES,
    GOOGLE_TRENDS_FEEDS.NL,
    GOOGLE_TRENDS_FEEDS.SE,
    GOOGLE_TRENDS_FEEDS.NO,
    GOOGLE_TRENDS_FEEDS.DK,
    GOOGLE_TRENDS_FEEDS.FI,
    GOOGLE_TRENDS_FEEDS.PL,
];

const GCC_FEEDS = [
    GOOGLE_TRENDS_FEEDS.AE,
    GOOGLE_TRENDS_FEEDS.SA,
    GOOGLE_TRENDS_FEEDS.QA,
    GOOGLE_TRENDS_FEEDS.KW,
    GOOGLE_TRENDS_FEEDS.OM,
    GOOGLE_TRENDS_FEEDS.BH,
];

// Preset collections for easy use
export const FEED_PRESETS = {
    ALL: Object.values(GOOGLE_TRENDS_FEEDS),
    US_ONLY: [GOOGLE_TRENDS_FEEDS.US],
    EUROPE: EUROPE_FEEDS,
    GCC: GCC_FEEDS,
    US_AND_EUROPE: [GOOGLE_TRENDS_FEEDS.US, ...EUROPE_FEEDS],
    US_AND_GCC: [GOOGLE_TRENDS_FEEDS.US, ...GCC_FEEDS],
};

// Helper function to get feeds as JSON string (for database storage)
export function getFeedsAsJson(preset: keyof typeof FEED_PRESETS): string {
    return JSON.stringify(FEED_PRESETS[preset]);
}

// Example usage:
// const myFeeds = FEED_PRESETS.US_AND_GCC;
// const jsonFeeds = getFeedsAsJson('ALL');
