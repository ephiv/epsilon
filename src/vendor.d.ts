declare module 'spark-md5' {
  const SparkMD5: {
    ArrayBuffer: {
      hash(buffer: ArrayBuffer | ArrayBufferLike): string;
    };
  };
  export default SparkMD5;
}
