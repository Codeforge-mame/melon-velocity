import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import create_engine, Column, String, Integer, DateTime, Boolean, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session

from app.core.config import settings

logger = logging.getLogger(__name__)

Base = declarative_base()


class ResolutionLog(Base):
    """Model for video resolution history logs."""
    __tablename__ = "resolution_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    url = Column(String(2048), nullable=False, index=True)
    title = Column(String(512), nullable=True)
    status = Column(String(50), nullable=False, index=True)  # success, error
    error_code = Column(String(50), nullable=True)
    error_message = Column(Text, nullable=True)
    installation_id = Column(String(128), nullable=True, index=True)
    ip_address = Column(String(45), nullable=True, index=True)
    formats_count = Column(Integer, nullable=True)
    cached = Column(Boolean, default=False)
    duration_seconds = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


class DatabaseService:
    """Database service for logging resolution history."""

    def __init__(self):
        self.engine = create_engine(
            settings.database_url,
            connect_args={"check_same_thread": False} if "sqlite" in settings.database_url else {}
        )
        self.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)

    def init_db(self):
        """Initialize database tables."""
        Base.metadata.create_all(bind=self.engine)
        logger.info("Database initialized")

    def get_session(self) -> Session:
        """Get a database session."""
        return self.SessionLocal()

    def log_resolution(
        self,
        url: str,
        status: str,
        title: Optional[str] = None,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
        installation_id: Optional[str] = None,
        ip_address: Optional[str] = None,
        formats_count: Optional[int] = None,
        cached: bool = False,
        duration_seconds: Optional[int] = None,
    ) -> Optional[int]:
        """Log a resolution attempt."""
        try:
            session = self.get_session()
            log_entry = ResolutionLog(
                url=url,
                title=title,
                status=status,
                error_code=error_code,
                error_message=error_message,
                installation_id=installation_id,
                ip_address=ip_address,
                formats_count=formats_count,
                cached=cached,
                duration_seconds=duration_seconds,
            )
            session.add(log_entry)
            session.commit()
            session.refresh(log_entry)
            session.close()
            return log_entry.id
        except Exception as e:
            logger.error(f"Failed to log resolution: {e}")
            return None

    def get_recent_resolutions(
        self,
        limit: int = 100,
        installation_id: Optional[str] = None,
    ) -> list[dict]:
        """Get recent resolution logs."""
        try:
            session = self.get_session()
            query = session.query(ResolutionLog)
            
            if installation_id:
                query = query.filter(ResolutionLog.installation_id == installation_id)
            
            results = query.order_by(ResolutionLog.created_at.desc()).limit(limit).all()
            
            logs = []
            for log in results:
                logs.append({
                    "id": log.id,
                    "url": log.url,
                    "title": log.title,
                    "status": log.status,
                    "error_code": log.error_code,
                    "error_message": log.error_message,
                    "formats_count": log.formats_count,
                    "cached": log.cached,
                    "duration_seconds": log.duration_seconds,
                    "created_at": log.created_at.isoformat() if log.created_at else None,
                })
            
            session.close()
            return logs
        except Exception as e:
            logger.error(f"Failed to get resolutions: {e}")
            return []


# Global database service instance
db_service = DatabaseService()
