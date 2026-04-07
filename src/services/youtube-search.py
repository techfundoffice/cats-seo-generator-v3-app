#!/usr/bin/env python3
"""YouTube video search for SEO article embedding.
Called by seo-generator-v3.ts searchYouTubeVideo() function.
Uses youtube_search library (no API key needed).
"""
import sys
import json
import re

from youtube_search import YoutubeSearch


def parse_view_count(views_str: str) -> int:
    """Extract numeric view count from strings like '994,843 views'."""
    nums = re.sub(r"[^0-9]", "", views_str or "")
    return int(nums) if nums else 0


def duration_to_iso(duration: str) -> str:
    """Convert '21:53' or '1:02:30' to ISO 8601 duration PT21M53S."""
    parts = (duration or "0").split(":")
    try:
        if len(parts) == 3:
            h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
            return f"PT{h}H{m}M{s}S"
        elif len(parts) == 2:
            m, s = int(parts[0]), int(parts[1])
            return f"PT{m}M{s}S"
        else:
            return f"PT{int(parts[0])}S"
    except (ValueError, IndexError):
        return "PT0S"


def main():
    if len(sys.argv) < 2:
        json.dump({"success": False, "error": "No search keyword provided"}, sys.stdout)
        return

    keyword = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 5

    try:
        results = YoutubeSearch(keyword, max_results=max_results).to_dict()
    except Exception as e:
        json.dump({"success": False, "keyword": keyword, "error": str(e)}, sys.stdout)
        return

    videos = []
    for r in results:
        video_id = r.get("id", "")
        thumbs = r.get("thumbnails", [])
        videos.append({
            "videoId": video_id,
            "title": r.get("title", ""),
            "description": r.get("long_desc") or "",
            "duration": r.get("duration", "0:00"),
            "durationISO": duration_to_iso(r.get("duration", "")),
            "channel": r.get("channel", ""),
            "views": r.get("views", "0 views"),
            "viewCount": parse_view_count(r.get("views", "")),
            "published": r.get("publish_time", ""),
            "publishedISO": "",
            "thumbnailUrl": thumbs[0] if thumbs else f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
            "embedUrl": f"https://www.youtube.com/embed/{video_id}",
            "watchUrl": f"https://www.youtube.com/watch?v={video_id}",
        })

    json.dump({
        "success": True,
        "keyword": keyword,
        "count": len(videos),
        "videos": videos,
    }, sys.stdout)


if __name__ == "__main__":
    main()
