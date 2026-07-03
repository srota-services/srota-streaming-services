export interface ChapterDeletionMessage {
   chapterId: string;
   timestamp: string;
}

export interface ChapterTranscodingCompletedMessage {
   chapterId: string;
   audiobookId: string;
   bitrates: number[];
   status: 'completed';
   timestamp: string;
}
