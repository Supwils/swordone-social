export interface TagPreset {
  slug: string;
  label: string;
}

export interface TagCategory {
  key: string;
  label: string;
  tags: TagPreset[];
}

const RAW: Record<string, { label: string; tags: Array<[string, string]> }> = {
  identity: {
    label: 'Identity',
    tags: [
      ['developer', 'Developer'],
      ['designer', 'Designer'],
      ['engineer', 'Engineer'],
      ['writer', 'Writer'],
      ['artist', 'Artist'],
      ['photographer', 'Photographer'],
      ['musician', 'Musician'],
      ['filmmaker', 'Filmmaker'],
      ['researcher', 'Researcher'],
      ['student', 'Student'],
      ['teacher', 'Teacher'],
      ['creator', 'Creator'],
      ['entrepreneur', 'Entrepreneur'],
      ['scientist', 'Scientist'],
      ['journalist', 'Journalist'],
      ['architect', 'Architect'],
      ['translator', 'Translator'],
      ['therapist', 'Therapist'],
      ['coach', 'Coach'],
      ['illustrator', 'Illustrator'],
      ['doctor', 'Doctor'],
      ['lawyer', 'Lawyer'],
    ],
  },
  personality: {
    label: 'Personality',
    tags: [
      ['introvert', 'Introvert'],
      ['extrovert', 'Extrovert'],
      ['thinker', 'Thinker'],
      ['dreamer', 'Dreamer'],
      ['maker', 'Maker'],
      ['minimalist', 'Minimalist'],
      ['optimist', 'Optimist'],
      ['night-owl', 'Night Owl'],
      ['morning-person', 'Morning Person'],
      ['wanderer', 'Wanderer'],
      ['observer', 'Observer'],
      ['empath', 'Empath'],
      ['curious', 'Curious'],
      ['quiet', 'Quiet'],
      ['reflective', 'Reflective'],
      ['gentle', 'Gentle'],
      ['playful', 'Playful'],
      ['explorer', 'Explorer'],
      ['perfectionist', 'Perfectionist'],
      ['spontaneous', 'Spontaneous'],
      ['independent', 'Independent'],
    ],
  },
  interests: {
    label: 'Interests',
    tags: [
      ['gamer', 'Gamer'],
      ['reader', 'Reader'],
      ['traveler', 'Traveler'],
      ['cyclist', 'Cyclist'],
      ['climber', 'Climber'],
      ['runner', 'Runner'],
      ['swimmer', 'Swimmer'],
      ['hiker', 'Hiker'],
      ['gardener', 'Gardener'],
      ['painter', 'Painter'],
      ['dancer', 'Dancer'],
      ['singer', 'Singer'],
      ['poet', 'Poet'],
      ['philosopher', 'Philosopher'],
      ['cinephile', 'Cinephile'],
      ['bookworm', 'Bookworm'],
      ['tea-lover', 'Tea Lover'],
      ['coffee-addict', 'Coffee Addict'],
      ['foodie', 'Foodie'],
      ['baker', 'Baker'],
      ['cat-person', 'Cat Person'],
      ['dog-person', 'Dog Person'],
    ],
  },
  tech: {
    label: 'Tech',
    tags: [
      ['programmer', 'Programmer'],
      ['open-source', 'Open Source'],
      ['linux', 'Linux'],
      ['ai-enthusiast', 'AI Enthusiast'],
      ['data-science', 'Data Science'],
      ['security', 'Security'],
      ['mobile-dev', 'Mobile Dev'],
      ['game-dev', 'Game Dev'],
      ['devops', 'DevOps'],
      ['hardware', 'Hardware'],
      ['blockchain', 'Blockchain'],
      ['web3', 'Web3'],
    ],
  },
  culture: {
    label: 'Arts & Culture',
    tags: [
      ['manga', 'Manga'],
      ['anime', 'Anime'],
      ['jazz', 'Jazz'],
      ['classical', 'Classical'],
      ['hip-hop', 'Hip-Hop'],
      ['indie', 'Indie'],
      ['electronic', 'Electronic'],
      ['rock', 'Rock'],
      ['theater', 'Theater'],
      ['museum', 'Museum'],
      ['streetwear', 'Streetwear'],
      ['vintage', 'Vintage'],
      ['k-pop', 'K-Pop'],
      ['calligraphy', 'Calligraphy'],
    ],
  },
  nature: {
    label: 'Nature',
    tags: [
      ['nature', 'Nature'],
      ['mountains', 'Mountains'],
      ['ocean', 'Ocean'],
      ['forest', 'Forest'],
      ['camping', 'Camping'],
      ['astronomy', 'Astronomy'],
      ['birdwatcher', 'Birdwatcher'],
      ['surfer', 'Surfer'],
      ['skater', 'Skater'],
      ['yoga', 'Yoga'],
    ],
  },
};

export const TAG_CATEGORIES: TagCategory[] = Object.entries(RAW).map(([key, val]) => ({
  key,
  label: val.label,
  tags: val.tags.map(([slug, label]) => ({ slug, label })),
}));

export const ALL_PRESET_TAGS: (TagPreset & { category: string })[] = TAG_CATEGORIES.flatMap((cat) =>
  cat.tags.map((t) => ({ ...t, category: cat.key })),
);
