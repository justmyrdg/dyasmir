import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  Max,
  ValidateIf,
  ValidateNested,
  IsNotEmpty,
  IsBase64,
  IsEmail,
} from 'class-validator';
import { SR_CODE_REGEX } from '../lib/sr-code';

// ---------------- Students ----------------

/** One subject the student takes, and the section they take it in. */
export class EnrollmentDto {
  @IsInt()
  @Min(1)
  subjectId!: number;

  @IsInt()
  @Min(1)
  sectionId!: number;
}

export class CreateStudentDto {
  @IsString()
  @Matches(SR_CODE_REGEX, { message: 'srCode must look like 23-12345' })
  srCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @IsInt()
  @Min(1)
  sectionId!: number;

  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password!: string;

  /** Optional. The student is emailed their SR code and password. */
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(255)
  email?: string | null;

  /** Subjects the student takes, each with its section. Omitted = every subject of their own section. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EnrollmentDto)
  enrollments?: EnrollmentDto[];
}

export class UpdateStudentDto {
  /** Replaces the student's subjects (each with its section). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EnrollmentDto)
  enrollments?: EnrollmentDto[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  sectionId?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** A new email address, or null to remove it. */
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(255)
  email?: string | null;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password!: string;
}

export class ImportStudentsDto {
  /** Raw CSV text (header row required). Send either this or xlsxBase64. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2_000_000)
  csv?: string;

  /** An .xlsx file (the downloadable template), base64-encoded. */
  @IsOptional()
  @IsBase64()
  @MaxLength(4_000_000)
  xlsxBase64?: string;
}

// ---------------- Reopen ----------------

export class ReopenAttemptDto {
  /** Minutes the student gets from now to revise and submit again. Left out: the attempt keeps its end time. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  minutes?: number;
}

// ---------------- Re-check ----------------

export class RecheckDto {
  /** true = correct (full points), false = wrong (0 points), null = back to the automatic check. */
  @ValidateIf((o: RecheckDto) => o.correct !== null)
  @IsBoolean()
  correct!: boolean | null;
}

// ---------------- Quizzes ----------------

export class ChoiceDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  id?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  text!: string;

  @IsBoolean()
  isCorrect!: boolean;
}

export class QuestionDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  id?: number;

  @IsIn(['multiple_choice', 'identification'])
  type!: 'multiple_choice' | 'identification';

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  text!: string;

  @IsInt()
  @Min(1)
  @Max(100)
  points!: number;

  @ValidateIf((q: QuestionDto) => q.type === 'multiple_choice')
  @IsArray()
  @ArrayMinSize(4, { message: 'multiple choice questions need exactly 4 choices' })
  @ArrayMaxSize(4, { message: 'multiple choice questions need exactly 4 choices' })
  @ValidateNested({ each: true })
  @Type(() => ChoiceDto)
  choices?: ChoiceDto[];

  @ValidateIf((q: QuestionDto) => q.type === 'identification')
  @IsArray()
  @ArrayMinSize(1, { message: 'identification questions need at least one accepted answer' })
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(500, { each: true })
  acceptedAnswers?: string[];
}

export class QuizDto {
  @IsInt()
  @Min(1)
  subjectId!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsInt()
  @Min(1)
  @Max(1440)
  timeLimitMinutes!: number;

  @IsBoolean()
  shuffleQuestions!: boolean;

  @IsBoolean()
  shuffleChoices!: boolean;

  @IsBoolean()
  showResultsToStudents!: boolean;

  /** Exam security (block copy/paste, full screen, record leaving). Default on. */
  @IsOptional()
  @IsBoolean()
  secureMode?: boolean;

  /** Submit automatically after this many times leaving the exam; 0 = only record. Default 5. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  maxViolations?: number;

  /** Each student gets this many questions, picked at random for them when they start. null = every question. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  itemsPerStudent?: number | null;

  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => QuestionDto)
  questions!: QuestionDto[];
}

export class ImportJsonDto {
  /** The parsed JSON file content (see data/quizzes.sample.json for the format). */
  @IsNotEmpty()
  data!: unknown;
}

// ---------------- Assignments ----------------

export class AssignmentItemDto {
  @IsInt()
  @Min(1)
  sectionId!: number;

  /** ISO 8601 with offset, e.g. 2026-10-20T08:00:00+08:00 */
  @IsISO8601({ strict: true })
  startAt!: string;

  @IsISO8601({ strict: true })
  dueAt!: string;
}

export class UpsertAssignmentsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AssignmentItemDto)
  items!: AssignmentItemDto[];
}

export class UpdateAssignmentDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  startAt?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  dueAt?: string;
}
