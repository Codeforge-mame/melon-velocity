from unittest.mock import Mock, patch

import pytest

from app.services.resolver import ResolverError, ResolverService


@pytest.fixture
def resolver_service():
    """Create a resolver service instance."""
    return ResolverService()


def test_generate_format_label(resolver_service):
    """Test format label generation."""
    fmt = {"height": 720, "ext": "mp4", "fps": 30}
    label = resolver_service._generate_format_label(fmt)
    assert "720p" in label
    assert "MP4" in label
    assert "30fps" in label


def test_generate_format_label_no_height(resolver_service):
    """Test format label generation without height."""
    fmt = {"ext": "mp4"}
    label = resolver_service._generate_format_label(fmt)
    assert "MP4" in label


def test_get_format_category_video_audio(resolver_service):
    """Test that formats with both video and audio are categorized as 'video'."""
    fmt = {"vcodec": "h264", "acodec": "aac"}
    assert resolver_service._get_format_category(fmt) == "video"


def test_get_format_category_video_only(resolver_service):
    """Test that video-only formats are categorized as 'video-only'."""
    fmt = {"vcodec": "h264", "acodec": "none"}
    assert resolver_service._get_format_category(fmt) == "video-only"


def test_get_format_category_audio_only(resolver_service):
    """Test that audio-only formats are categorized as 'audio-only'."""
    fmt = {"vcodec": "none", "acodec": "aac"}
    assert resolver_service._get_format_category(fmt) == "audio-only"


def test_deduplicate_formats(resolver_service):
    """Test format deduplication."""
    formats = [
        {"format_id": "1", "url": "http://example.com/1"},
        {"format_id": "2", "url": "http://example.com/2"},
        {"format_id": "1", "url": "http://example.com/1"},
    ]
    unique = resolver_service._deduplicate_formats(formats)
    assert len(unique) == 2
    assert unique[0]["format_id"] == "1"
    assert unique[1]["format_id"] == "2"


@patch("app.services.resolver.yt_dlp.YoutubeDL")
def test_resolve_video_success(mock_ydl_class, resolver_service):
    """Test successful video resolution."""
    # Mock yt-dlp response
    mock_ydl = Mock()
    mock_ydl_class.return_value.__enter__.return_value = mock_ydl

    mock_info = {
        "title": "Test Video",
        "thumbnail": "http://example.com/thumb.jpg",
        "duration": 120,
        "formats": [
            {
                "format_id": "137",
                "ext": "mp4",
                "height": 1080,
                "fps": 30,
                "vcodec": "h264",
                "acodec": "aac",
                "url": "http://example.com/video.mp4",
                "filesize": 50000000,
            }
        ],
    }
    mock_ydl.extract_info.return_value = mock_info

    result = resolver_service.resolve_video("https://example.com/video")

    assert result.sourceUrl == "https://example.com/video"
    assert result.title == "Test Video"
    assert result.thumbnailUrl == "http://example.com/thumb.jpg"
    assert result.durationSeconds == 120
    assert len(result.formats) == 1
    assert result.formats[0].formatId == "137"
    assert result.formats[0].category == "video"


@patch("app.services.resolver.yt_dlp.YoutubeDL")
def test_resolve_video_age_restricted(mock_ydl_class, resolver_service):
    """Test that age-restricted videos raise appropriate error."""
    mock_ydl = Mock()
    mock_ydl_class.return_value.__enter__.return_value = mock_ydl

    mock_info = {"age_limit": 18}
    mock_ydl.extract_info.return_value = mock_info

    with pytest.raises(ResolverError) as exc_info:
        resolver_service.resolve_video("https://example.com/video")

    assert exc_info.value.code == "AGE_OR_ACCESS_RESTRICTION"


@patch("app.services.resolver.yt_dlp.YoutubeDL")
def test_resolve_video_multiple_categories(mock_ydl_class, resolver_service):
    """Test that videos with multiple format categories are all included."""
    mock_ydl = Mock()
    mock_ydl_class.return_value.__enter__.return_value = mock_ydl

    mock_info = {
        "title": "Test Video",
        "formats": [
            {"format_id": "1", "vcodec": "h264", "acodec": "aac", "url": "http://example.com/video.mp4"},
            {"format_id": "2", "vcodec": "h264", "acodec": "none", "url": "http://example.com/video-only.mp4"},
            {"format_id": "3", "vcodec": "none", "acodec": "aac", "url": "http://example.com/audio.mp4"},
        ],
    }
    mock_ydl.extract_info.return_value = mock_info

    result = resolver_service.resolve_video("https://example.com/video")

    assert len(result.formats) == 3
    categories = {f.category for f in result.formats}
    assert categories == {"video", "video-only", "audio-only"}


@patch("app.services.resolver.yt_dlp.YoutubeDL")
def test_resolve_video_unavailable(mock_ydl_class, resolver_service):
    """Test that unavailable videos raise appropriate error."""
    mock_ydl = Mock()
    mock_ydl_class.return_value.__enter__.return_value = mock_ydl

    mock_ydl.extract_info.side_effect = Exception("Video unavailable")

    with pytest.raises(ResolverError) as exc_info:
        resolver_service.resolve_video("https://example.com/video")

    assert exc_info.value.code == "EXTRACTION_FAILED"
