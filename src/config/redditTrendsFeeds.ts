// Reddit Trends JSON Feeds Configuration
export const REDDIT_TRENDS_FEEDS = {
    ALL_HOT: 'https://www.reddit.com/r/all/hot.json',
    ALL_RISING: 'https://www.reddit.com/r/all/rising.json',
    ALL_TOP_DAY: 'https://www.reddit.com/r/all/top.json?t=day',
    POPULAR_HOT: 'https://www.reddit.com/r/popular/hot.json',
    POPULAR_RISING: 'https://www.reddit.com/r/popular/rising.json',
};

export const REDDIT_PRESETS = {
    ALL: Object.values(REDDIT_TRENDS_FEEDS),
    BIG_PICTURE: [
        REDDIT_TRENDS_FEEDS.ALL_HOT,
        REDDIT_TRENDS_FEEDS.ALL_RISING,
        REDDIT_TRENDS_FEEDS.ALL_TOP_DAY,
    ],
    POPULAR: [
        REDDIT_TRENDS_FEEDS.POPULAR_HOT,
        REDDIT_TRENDS_FEEDS.POPULAR_RISING,
    ],
};
