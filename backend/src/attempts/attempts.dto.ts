import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { STUDENT_EVENT_TYPES, type AttemptEventType } from './security';

export class StartAttemptDto {
  @IsInt()
  @Min(1)
  assignmentId!: number;
}

export class AnswerDto {
  @IsInt()
  @Min(1)
  questionId!: number;

  /** Choice id (as a string) for multiple choice, free text for identification. Empty string clears the answer. */
  @IsString()
  @MaxLength(500)
  answer!: string;
}

/** Autosave payload. Students can only send answers and their current position — nothing else on the attempt. */
export class SaveAttemptDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AnswerDto)
  answers?: AnswerDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  currentIndex?: number;
}

export class AttemptEventDto {
  /** Random id from the browser; resending the same event is ignored. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{8,40}$/)
  id?: string;

  @IsIn(STUDENT_EVENT_TYPES as string[])
  type!: AttemptEventType;

  /** The browser's own time, kept for reference only (the server time is what counts). */
  @IsOptional()
  @IsISO8601()
  clientTime?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400_000)
  durationMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  detail?: string;
}

export class RecordEventsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AttemptEventDto)
  events!: AttemptEventDto[];
}
